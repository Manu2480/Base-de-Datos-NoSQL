"""Load the dermatology corpus into the same database as the clinical catalog.

Reads datos/conocimiento/documentos_conocimiento.json and upserts each text in
documentos_conocimiento. Disease topics are linked to diagnosticos_dermatologicos
by name. Transversal guides stay unlinked.
"""

from __future__ import annotations

import json
import logging
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from bson import ObjectId

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
}


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
    for raw in raw_documents:
        document = prepare_document(raw, diagnosis_ids)
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

    logger.info(
        "Conocimiento en vector_db: %s nuevos, %s actualizados, %s enlazados a un diagnóstico.",
        inserted,
        replaced,
        linked,
    )


if __name__ == "__main__":
    try:
        load()
    except Exception:
        logger.exception("No se pudo cargar el corpus de conocimiento.")
        sys.exit(1)
    finally:
        close_client()
