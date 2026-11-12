"""Load the dermatology corpus into the same database as the clinical catalog.

Reads datos/conocimiento/documentos_conocimiento.json and replaces
documentos_conocimiento with that corpus. Disease topics are linked to
diagnosticos_dermatologicos by name, including the English aliases used by
some articles. Transversal guides stay unlinked.

Reference photographs in datos/conocimiento/imagenes_referencia are stored in
GridFS and in imagenes, linked to their diagnosis. Patient case images are left
in place.
"""

from __future__ import annotations

import csv
import hashlib
import json
import logging
import os
import sys
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Any

from bson import ObjectId
from gridfs import GridFSBucket

from .ai import active_embedding_model, embed_image, embed_texts
from .chunking import STRATEGIES, chunk_text, split_sentences
from .init_db import initialize
from .mongo import close_client, get_database

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

CORPUS_PATH = (
    Path(__file__).resolve().parents[1]
    / "datos"
    / "conocimiento"
    / "documentos_conocimiento.json"
)

TEMA_A_NOMBRE = {
    "acne-vulgar": "Acné vulgar",
    "alopecia-androgenetica": "Alopecia androgenética",
    "alopecia-areata": "Alopecia areata",
    "candidiasis-cutanea": "Candidiasis cutánea",
    "carcinoma-basocelular": "Carcinoma basocelular",
    "carcinoma-espinocelular": "Carcinoma espinocelular",
    "celulitis": "Celulitis",
    "dermatitis-atopica": "Dermatitis atópica",
    "dermatitis-contacto-alergica": "Dermatitis de contacto alérgica",
    "epidermolisis-ampollosa": "Epidermólisis ampollosa",
    "escabiosis": "Escabiosis",
    "foliculitis-bacteriana": "Foliculitis bacteriana",
    "herpes-simple": "Herpes simple",
    "herpes-zoster": "Herpes zóster",
    "ictiosis-vulgar": "Ictiosis vulgar",
    "impetigo": "Impétigo",
    "lipoma": "Lipoma",
    "lupus-eritematoso-cutaneo": "Lupus eritematoso cutáneo",
    "melanoma": "Melanoma",
    "nevus-melanocitico": "Nevus melanocítico",
    "psoriasis-en-placas": "Psoriasis en placas",
    "queratosis-seborreica": "Queratosis seborreica",
    "rosacea": "Rosácea",
    "tinea-pedis": "Tiña pedis",
    "verruga-vulgar": "Verruga vulgar",
    "vitiligo": "Vitíligo",
    "acne-vulgaris": "Acné vulgar",
    "androgenetic-alopecia": "Alopecia androgenética",
}

IMAGES_DIR = CORPUS_PATH.parent / "imagenes_referencia"


def parse_fecha(value: Any) -> datetime:
    if isinstance(value, dict) and "$date" in value:
        value = value["$date"]
    if isinstance(value, str):
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    if isinstance(value, datetime):
        return value
    raise ValueError(f"Fecha de documento no reconocida: {value!r}")


def prepare_document(raw: dict[str, Any], diagnosis_ids: dict[str, ObjectId]) -> dict[str, Any]:
    tema = raw.get("tema") or ""
    document = {
        "nombre_archivo": raw["nombre_archivo"],
        "tipo_documento": raw.get("tipo_documento") or "Texto",
        "idioma": raw.get("idioma") or "es",
        "contenido_texto": raw["contenido_texto"],
        "fecha": parse_fecha(raw.get("fecha")),
        "titulo": raw.get("titulo") or "",
        "tema": tema,
        "categoria": raw.get("categoria") or "",
        "fuente": raw.get("fuente") or "",
    }
    diagnosis_name = TEMA_A_NOMBRE.get(tema)
    if diagnosis_name and diagnosis_name in diagnosis_ids:
        document["diagnostico_id"] = diagnosis_ids[diagnosis_name]
    return document


def _diagnosis_id(topic: str, diagnosis_ids: dict[str, ObjectId]) -> ObjectId | None:
    name = TEMA_A_NOMBRE.get(topic.strip())
    if not name:
        return None
    return diagnosis_ids.get(name)


def load_reference_images(database, diagnosis_ids: dict[str, ObjectId]) -> None:
    index_path = IMAGES_DIR / "_indice_imagenes.csv"
    if not index_path.is_file():
        logger.info("No hay índice de imágenes de referencia.")
        return

    bucket = GridFSBucket(database)
    previous = list(database["imagenes"].find({"origen": "referencia"}, {"archivo_file_id": 1}))
    for item in previous:
        file_id = item.get("archivo_file_id")
        if file_id is not None:
            try:
                bucket.delete(file_id)
            except Exception:
                logger.warning("No se pudo borrar el archivo %s de GridFS.", file_id)
    if previous:
        database["imagenes"].delete_many({"origen": "referencia"})

    stored = linked = 0
    with index_path.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            relative = (row.get("archivo") or "").strip()
            image_path = IMAGES_DIR / relative
            if not relative or not image_path.is_file():
                logger.warning("Falta la imagen de referencia %s.", relative or image_path)
                continue
            topics = [topic.strip() for topic in (row.get("afecciones_del_pdf") or "").split(";") if topic.strip()]
            primary = _diagnosis_id(row.get("afeccion") or "", diagnosis_ids)
            related = [diagnosis for topic in topics if (diagnosis := _diagnosis_id(topic, diagnosis_ids))]
            caption = (row.get("pie_de_figura_en_la_pagina") or "").strip()
            image_bytes = image_path.read_bytes()
            linked_names = [
                name
                for name, diagnosis in diagnosis_ids.items()
                if diagnosis == primary or diagnosis in related
            ]
            vector_source = " ".join([*dict.fromkeys(linked_names), caption]).strip() or "referencia clínica"
            if os.getenv("JINA_API_KEY"):
                visual_embedding = embed_image(image_bytes, "image/jpeg")
            else:
                visual_embedding = embed_texts([vector_source])[0]
            file_id = bucket.upload_from_stream(
                image_path.name,
                BytesIO(image_bytes),
                metadata={"content_type": "image/jpeg", "origen": "referencia"},
            )
            document: dict[str, Any] = {
                "archivo": f"referencias/{relative}",
                "archivo_file_id": file_id,
                "origen": "referencia",
                "pdf_origen": row.get("pdf_origen") or "",
                "pie_figura": caption or "sin pie de figura",
                "fecha_registro": datetime.now(timezone.utc),
                "embedding_visual": visual_embedding,
                "modelo_embedding": active_embedding_model(),
                "descripcion_visual": {
                    "colores": [],
                    "texturas": [],
                },
            }
            if str(row.get("pagina") or "").isdigit():
                document["pagina"] = int(row["pagina"])
            if primary is not None:
                document["diagnostico_id"] = primary
                linked += 1
            if related:
                document["diagnosticos_ids"] = related
            database["imagenes"].insert_one(document)
            stored += 1
    logger.info("Imágenes de referencia: %s guardadas, %s enlazadas a un diagnóstico.", stored, linked)


def load() -> None:
    if not CORPUS_PATH.is_file():
        raise SystemExit(f"No se encontró el corpus en {CORPUS_PATH}.")

    initialize()
    database = get_database()
    raw_documents = json.loads(CORPUS_PATH.read_text(encoding="utf-8"))
    diagnosis_ids = {
        item["nombre"]: item["_id"]
        for item in database["diagnosticos_dermatologicos"].find(
            {"nombre": {"$in": list(TEMA_A_NOMBRE.values())}},
            {"nombre": 1},
        )
    }
    missing = [name for name in TEMA_A_NOMBRE.values() if name not in diagnosis_ids]
    if missing:
        logger.warning(
            "Hay %s diagnósticos clínicos sin cargar. Esos textos quedan sin diagnostico_id.",
            len(missing),
        )

    inserted = replaced = linked = 0
    names: list[str] = []
    for raw in raw_documents:
        document = prepare_document(raw, diagnosis_ids)
        names.append(document["nombre_archivo"])
        if "diagnostico_id" in document:
            linked += 1
        result = database["documentos_conocimiento"].replace_one(
            {"nombre_archivo": document["nombre_archivo"]},
            document,
            upsert=True,
        )
        if result.upserted_id is not None:
            inserted += 1
        else:
            replaced += 1

    removed = database["documentos_conocimiento"].delete_many(
        {"nombre_archivo": {"$nin": names}}
    ).deleted_count
    logger.info(
        "Conocimiento en vector_db: %s nuevos, %s actualizados, %s retirados, %s enlazados a un diagnóstico.",
        inserted,
        replaced,
        removed,
        linked,
    )
    ensure_chunks(database)
    load_reference_images(database, diagnosis_ids)


def ensure_chunks(database) -> None:
    """Chunk every knowledge document and store a 1024-d vector.

    Documents that already have chunks for the same text and embedding model
    are left in place, so a restart does not wipe the RAG store.
    """
    model = active_embedding_model()
    documents = list(
        database["documentos_conocimiento"].find(
            {},
            {"contenido_texto": 1, "idioma": 1, "fecha": 1, "nombre_archivo": 1},
        )
    )
    kept_ids: list[Any] = []
    created = skipped = 0
    for document in documents:
        text = (document.get("contenido_texto") or "").strip()
        if not text:
            continue
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        kept_ids.append(document["_id"])
        current = database["chunks"].find_one(
            {"doc_id": document["_id"]},
            {"contenido_sha256": 1, "modelo": 1},
        )
        if (
            current
            and current.get("contenido_sha256") == digest
            and current.get("modelo") == model
        ):
            skipped += 1
            continue
        database["chunks"].delete_many({"doc_id": document["_id"]})
        rows = _chunk_rows(document, text, digest, model)
        if rows:
            database["chunks"].insert_many(rows, ordered=False)
            created += len(rows)
        logger.info("Fragmentos de %s: %s.", document.get("nombre_archivo"), len(rows))
    removed = 0
    if kept_ids:
        removed = database["chunks"].delete_many({"doc_id": {"$nin": kept_ids}}).deleted_count
    logger.info(
        "Fragmentos listos para RAG: %s escritos, %s documentos ya al día, %s huérfanos retirados. Modelo: %s.",
        created,
        skipped,
        removed,
        model,
    )


def _chunk_rows(document: dict[str, Any], text: str, digest: str, model: str) -> list[dict[str, Any]]:
    now = datetime.now(timezone.utc)
    rows: list[dict[str, Any]] = []
    for strategy in STRATEGIES:
        if strategy == "semantic":
            sentences = split_sentences(text)
            if not sentences:
                continue
            parts = chunk_text(text, strategy, embed_texts(sentences))
        else:
            parts = chunk_text(text, strategy)
        parts = [part for part in parts if part.strip()]
        if not parts:
            continue
        for index, (part, vector) in enumerate(zip(parts, embed_texts(parts))):
            rows.append(
                {
                    "doc_id": document["_id"],
                    "chunk_index": index,
                    "estrategia_chunking": strategy,
                    "chunk_texto": part,
                    "embedding": vector,
                    "modelo": model,
                    "idioma": document.get("idioma") or "es",
                    "fecha": document.get("fecha") or now,
                    "fecha_ingesta": now,
                    "contenido_sha256": digest,
                }
            )
    return rows


if __name__ == "__main__":
    try:
        load()
    except Exception:
        logger.exception("No se pudo cargar el corpus de conocimiento.")
        sys.exit(1)
    finally:
        close_client()
