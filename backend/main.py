from __future__ import annotations

import logging
import os
import re
from datetime import datetime
from io import BytesIO
from typing import Any, Literal

from bson import ObjectId
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Query, Response, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from gridfs import GridFSBucket
from gridfs.errors import NoFile
from pydantic import BaseModel, Field, field_validator
from pymongo.errors import OperationFailure, PyMongoError

from .ai import EMBEDDING_MODEL, embed_image, embed_texts, generate_answer
from .chunking import STRATEGIES, chunk_text, split_sentences
from .mongo import COLLECTIONS, close_client, get_database, normalize_for_mongo, serialize_document

load_dotenv()
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)

app = FastAPI(
    title="DermAssist RAG API",
    description="API de apoyo académico para información dermatológica con MongoDB y recuperación RAG.",
    version="1.0.0",
)
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class DocumentInput(BaseModel):
    nombre_archivo: str = Field(min_length=1, max_length=200)
    tipo_documento: str = "Texto"
    idioma: str = "es"
    contenido_texto: str = Field(min_length=1, max_length=1_000_000)
    fuente: str | None = None

    @field_validator("nombre_archivo", "contenido_texto")
    @classmethod
    def reject_blank_text(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("El valor no puede estar vacío.")
        return normalized


class IngestInput(DocumentInput):
    estrategias: list[Literal["fixed-size", "sentence-aware", "semantic"]] = Field(
        default_factory=lambda: list(STRATEGIES), min_length=1
    )
    umbral_semantico: float = Field(default=0.8, ge=0, le=1)

    @field_validator("estrategias")
    @classmethod
    def reject_duplicate_strategies(
        cls, strategies: list[str]
    ) -> list[str]:
        if len(strategies) != len(set(strategies)):
            raise ValueError("No se permiten estrategias de chunking duplicadas.")
        return strategies


class SearchInput(BaseModel):
    query: str = Field(min_length=1, max_length=4000)
    modo: Literal["text", "vector"] = "vector"
    estrategia_chunking: Literal["fixed-size", "sentence-aware", "semantic"] | None = None
    idioma: str | None = None
    fecha_desde: datetime | None = None
    fecha_hasta: datetime | None = None
    top_k: int = Field(default=5, ge=1, le=20)

    @field_validator("query")
    @classmethod
    def reject_blank_query(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("La consulta no puede estar vacía.")
        return normalized


class RagInput(SearchInput):
    modo: Literal["vector"] = "vector"


class QueryHistoryInput(BaseModel):
    consulta: str = Field(min_length=1, max_length=4000)
    estrategia_chunking: str | None = None

    @field_validator("consulta")
    @classmethod
    def reject_blank_query(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("La consulta no puede estar vacía.")
        return normalized


def _collection(name: str):
    if name not in COLLECTIONS:
        raise HTTPException(status_code=404, detail="La colección solicitada no está habilitada en la API.")
    return get_database()[name]


def _search_filter(request: SearchInput) -> dict[str, Any]:
    filters: dict[str, Any] = {}
    if request.estrategia_chunking:
        filters["estrategia_chunking"] = {"$eq": request.estrategia_chunking}
    if request.idioma:
        filters["idioma"] = {"$eq": request.idioma}
    if request.fecha_desde or request.fecha_hasta:
        dates: dict[str, datetime] = {}
        if request.fecha_desde:
            dates["$gte"] = request.fecha_desde
        if request.fecha_hasta:
            dates["$lte"] = request.fecha_hasta
        filters["fecha"] = dates
    return filters


def _vector_search(
    query_vector: list[float], request: SearchInput, collection_name: str = "chunks"
) -> list[dict[str, Any]]:
    collection = _collection(collection_name)
    path = "embedding_visual" if collection_name == "imagenes" else "embedding"
    index = "imagenes_vector_index" if collection_name == "imagenes" else "chunks_vector_index"
    vector_stage: dict[str, Any] = {
        "index": index,
        "path": path,
        "queryVector": query_vector,
        "numCandidates": max(100, request.top_k * 10),
        "limit": request.top_k,
    }
    filters = _search_filter(request)
    if filters and collection_name == "chunks":
        vector_stage["filter"] = filters
    pipeline: list[dict[str, Any]] = [{"$vectorSearch": vector_stage}]
    if collection_name == "chunks":
        pipeline.append(
            {
                "$lookup": {
                    "from": "documentos_conocimiento",
                    "localField": "doc_id",
                    "foreignField": "_id",
                    "as": "documento",
                }
            }
        )
        document_name = {"$arrayElemAt": ["$documento.nombre_archivo", 0]}
    else:
        document_name = "$$REMOVE"
    pipeline.append(
        {
            "$project": {
                "_id": 1,
                "doc_id": 1,
                "chunk_index": 1,
                "estrategia_chunking": 1,
                "chunk_texto": 1,
                "idioma": 1,
                "archivo": 1,
                "archivo_file_id": 1,
                "descripcion_visual": 1,
                "diagnostico_id": 1,
                "nombre_archivo": document_name,
                "score": {"$meta": "vectorSearchScore"},
            }
        }
    )
    try:
        return [serialize_document(item) for item in collection.aggregate(pipeline)]
    except OperationFailure as exc:
        logger.warning("Falló la búsqueda vectorial en %s: %s", collection_name, exc.code)
        raise HTTPException(
            status_code=503,
            detail=f"No está disponible el índice Atlas '{index}'. Ejecute backend/init_db.py y cree el índice vectorial descrito en docs/API_Y_PLANTILLA.md.",
        ) from exc


def _text_search(request: SearchInput) -> list[dict[str, Any]]:
    chunks = _collection("chunks")
    query = request.query.strip()
    mongo_filter: dict[str, Any] = {}
    filters = _search_filter(request)
    if request.estrategia_chunking:
        mongo_filter["estrategia_chunking"] = request.estrategia_chunking
    if request.idioma:
        mongo_filter["idioma"] = request.idioma
    if request.fecha_desde or request.fecha_hasta:
        if "fecha" in filters:
            mongo_filter["fecha"] = filters["fecha"]
    try:
        cursor = chunks.find(
            {"$text": {"$search": query}, **mongo_filter},
            {"score": {"$meta": "textScore"}},
        ).sort([("score", {"$meta": "textScore"})]).limit(request.top_k)
        return [serialize_document(item) for item in cursor]
    except OperationFailure as exc:
        if exc.code != 27:
            logger.exception("Falló la búsqueda textual de chunks.")
            raise HTTPException(
                status_code=503, detail="MongoDB no pudo ejecutar la búsqueda textual."
            ) from exc
        safe_query = re.escape(query)
        mongo_filter["chunk_texto"] = {"$regex": safe_query, "$options": "i"}
        return [
            serialize_document(item)
            for item in chunks.find(mongo_filter).limit(request.top_k)
        ]


def _read_image(image: UploadFile) -> tuple[bytes, str]:
    allowed_types = {"image/jpeg", "image/png", "image/webp"}
    if image.content_type not in allowed_types:
        raise HTTPException(status_code=415, detail="Solo se aceptan imágenes JPEG, PNG o WEBP.")
    content = image.file.read(5 * 1024 * 1024 + 1)
    if not content or len(content) > 5 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="La imagen debe pesar entre 1 byte y 5 MB.")
    image_signatures = {
        "image/jpeg": content.startswith(b"\xff\xd8\xff"),
        "image/png": content.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/webp": len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP",
    }
    if not image_signatures[image.content_type]:
        raise HTTPException(status_code=422, detail="El contenido del archivo no coincide con su formato.")
    return content, image.content_type


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/api/health")
def health() -> dict[str, Any]:
    configured = bool(os.getenv("MONGODB_URI"))
    try:
        database = get_database()
        database.command("ping")
        return {"status": "ok", "mongodb": "connected", "database": database.name}
    except HTTPException as exc:
        return {
            "status": "degraded",
            "mongodb": "disconnected",
            "configured": configured,
            "detail": exc.detail,
        }
    except PyMongoError:
        logger.warning("MongoDB health ping failed.")
        return {
            "status": "degraded",
            "mongodb": "disconnected",
            "configured": configured,
            "detail": "MongoDB no respondió al ping.",
        }


@app.get("/api/dashboard")
def dashboard() -> dict[str, Any]:
    database = get_database()
    return {
        "database": database.name,
        "collections": [
            {"name": name, "count": database[name].estimated_document_count()}
            for name in COLLECTIONS
        ],
    }


@app.get("/api/collections")
def list_collections() -> list[str]:
    return list(COLLECTIONS)


@app.get("/api/diagnoses")
def diagnoses_by_symptoms(symptoms: str = Query(min_length=1, max_length=300)) -> dict[str, Any]:
    database = get_database()
    symptom_names = [value.strip() for value in symptoms.split(",") if value.strip()]
    if not symptom_names:
        raise HTTPException(status_code=422, detail="Indique al menos un síntoma.")
    matching_symptoms = list(
        database["sintomas"].find(
            {"nombre": {"$in": [re.compile(re.escape(name), re.IGNORECASE) for name in symptom_names]}}
        )
    )
    symptom_ids = [item["_id"] for item in matching_symptoms]
    diagnoses = list(
        database["diagnosticos_dermatologicos"].find(
            {"sintomas_ids": {"$in": symptom_ids}} if symptom_ids else {"_id": {"$exists": False}}
        )
    )
    return {
        "symptoms_matched": [serialize_document(item) for item in matching_symptoms],
        "diagnoses": [serialize_document(item) for item in diagnoses],
    }


@app.get("/api/users/{user_id}/queries")
def user_query_history(user_id: str) -> dict[str, Any]:
    if not ObjectId.is_valid(user_id):
        raise HTTPException(status_code=422, detail="El identificador debe ser un ObjectId válido.")
    user = _collection("usuarios").find_one(
        {"_id": ObjectId(user_id)}, {"historial_consultas": 1, "nombre": 1}
    )
    if user is None:
        raise HTTPException(status_code=404, detail="No se encontró el usuario.")
    return {
        "user_id": user_id,
        "historial_consultas": serialize_document(user.get("historial_consultas", [])),
    }


@app.post("/api/users/{user_id}/queries", status_code=201)
def record_user_query(user_id: str, payload: QueryHistoryInput) -> dict[str, Any]:
    if not ObjectId.is_valid(user_id):
        raise HTTPException(status_code=422, detail="El identificador debe ser un ObjectId válido.")
    entry = {
        "consulta": payload.consulta,
        "estrategia_chunking": payload.estrategia_chunking,
        "fecha": datetime.utcnow(),
    }
    result = _collection("usuarios").update_one(
        {"_id": ObjectId(user_id)},
        {"$push": {"historial_consultas": {"$each": [entry], "$slice": -50}}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="No se encontró el usuario.")
    return {"user_id": user_id, "consulta": serialize_document(entry)}


@app.get("/api/diagnoses/{diagnosis_id}/treatments")
def treatments_for_diagnosis(diagnosis_id: str) -> dict[str, Any]:
    if not ObjectId.is_valid(diagnosis_id):
        raise HTTPException(status_code=422, detail="El identificador debe ser un ObjectId válido.")
    database = get_database()
    reference_id = ObjectId(diagnosis_id)
    diagnosis = database["diagnosticos_dermatologicos"].find_one({"_id": reference_id})
    if diagnosis is None:
        raise HTTPException(status_code=404, detail="No se encontró el diagnóstico.")
    treatments = list(database["tratamientos"].find({"diagnosticos_ids": reference_id}))
    for treatment in treatments:
        for medication in treatment.get("medicamentos", []):
            medicine = database["medicamentos"].find_one({"_id": medication.get("medicamento_id")})
            medication["medicamento"] = serialize_document(medicine) if medicine else None
    return {
        "diagnosis": serialize_document(diagnosis),
        "treatments": [serialize_document(item) for item in treatments],
    }


@app.get("/api/patients/{patient_id}/history")
def patient_history(patient_id: str) -> dict[str, Any]:
    if not ObjectId.is_valid(patient_id):
        raise HTTPException(status_code=422, detail="El identificador debe ser un ObjectId válido.")
    database = get_database()
    reference_id = ObjectId(patient_id)
    patient = database["pacientes"].find_one({"_id": reference_id})
    if patient is None:
        raise HTTPException(status_code=404, detail="No se encontró el paciente.")
    histories = list(database["historias_medicas"].find({"paciente_id": reference_id}))
    diagnoses = list(database["diagnosticos_asignados"].find({"paciente_id": reference_id}))
    laboratories = list(database["resultados_laboratorio"].find({"paciente_id": reference_id}))
    return {
        "patient": serialize_document(patient),
        "medical_histories": [serialize_document(item) for item in histories],
        "assigned_diagnoses": [serialize_document(item) for item in diagnoses],
        "laboratory_results": [serialize_document(item) for item in laboratories],
    }


@app.get("/api/patients/{patient_id}/diagnosis-sequence")
def patient_diagnosis_sequence(patient_id: str) -> dict[str, Any]:
    if not ObjectId.is_valid(patient_id):
        raise HTTPException(status_code=422, detail="El identificador debe ser un ObjectId válido.")
    database = get_database()
    reference_id = ObjectId(patient_id)
    if database["pacientes"].find_one({"_id": reference_id}, {"_id": 1}) is None:
        raise HTTPException(status_code=404, detail="No se encontró el paciente.")
    assigned = list(
        database["diagnosticos_asignados"]
        .find({"paciente_id": reference_id})
        .sort([("episodio_fecha", 1), ("fecha_diagnostico", 1)])
    )
    sequence = []
    for item in assigned:
        diagnosis = database["diagnosticos_dermatologicos"].find_one(
            {"_id": item.get("diagnostico_id")}, {"nombre": 1, "categoria": 1}
        )
        sequence.append(
            {
                "fecha": serialize_document(item.get("episodio_fecha") or item.get("fecha_diagnostico")),
                "diagnostico": serialize_document(diagnosis),
                "vigente": item.get("vigente"),
            }
        )
    transitions: dict[str, int] = {}
    names = [item["diagnostico"]["nombre"] for item in sequence if item["diagnostico"]]
    for previous, current in zip(names, names[1:]):
        key = f"{previous} → {current}"
        transitions[key] = transitions.get(key, 0) + 1
    return {"sequence": sequence, "observed_transitions": transitions}


@app.get("/api/patients/{patient_id}/medication-risks")
def patient_medication_risks(patient_id: str) -> dict[str, Any]:
    if not ObjectId.is_valid(patient_id):
        raise HTTPException(status_code=422, detail="El identificador debe ser un ObjectId válido.")
    database = get_database()
    reference_id = ObjectId(patient_id)
    patient = database["pacientes"].find_one({"_id": reference_id})
    if patient is None:
        raise HTTPException(status_code=404, detail="No se encontró el paciente.")
    allergies = [
        str(item.get("sustancia", "")).casefold()
        for item in patient.get("alergias", [])
        if isinstance(item, dict) and item.get("sustancia")
    ]
    matches: list[dict[str, Any]] = []
    assigned_diagnoses = database["diagnosticos_asignados"].find(
        {"paciente_id": reference_id, "vigente": True}
    )
    for diagnosis in assigned_diagnoses:
        for assigned_treatment in diagnosis.get("tratamientos_asignados", []):
            if not assigned_treatment.get("vigente", True):
                continue
            for assigned_medicine in assigned_treatment.get("medicamentos", []):
                medicine = database["medicamentos"].find_one(
                    {"_id": assigned_medicine.get("medicamento_id")}
                )
                if not medicine:
                    continue
                text_fields = [
                    medicine.get("nombre", ""),
                    medicine.get("principio_activo", ""),
                    *medicine.get("contraindicaciones", []),
                    *[
                        item.get("descripcion", "")
                        for item in medicine.get("interacciones", [])
                        if isinstance(item, dict)
                    ],
                ]
                for allergy in allergies:
                    for text in text_fields:
                        if allergy and allergy in str(text).casefold():
                            matches.append(
                                {
                                    "sustancia_alergia": allergy,
                                    "medicamento": medicine.get("nombre"),
                                    "coincidencia_documentada": str(text),
                                    "diagnostico_asignado_id": serialize_document(diagnosis.get("_id")),
                                }
                            )
    return {
        "documented_matches": matches,
        "disclaimer": (
            "Solo se detectan coincidencias textuales exactas en los datos almacenados. "
            "La ausencia de coincidencias no descarta interacciones ni riesgos; no use este "
            "resultado para tomar decisiones clínicas."
        ),
    }


@app.get("/api/collections/{name}")
def list_documents(
    name: str,
    q: str | None = Query(default=None, max_length=200),
    limit: int = Query(default=20, ge=1, le=100),
    skip: int = Query(default=0, ge=0, le=100_000),
) -> dict[str, Any]:
    collection = _collection(name)
    query_filter: dict[str, Any] = {}
    if q:
        pattern = re.escape(q)
        searchable_fields = {
            "documentos_conocimiento": ["nombre_archivo", "contenido_texto"],
            "chunks": ["chunk_texto", "estrategia_chunking"],
            "diagnosticos_dermatologicos": ["nombre", "categoria", "descripcion"],
            "sintomas": ["nombre", "descripcion"],
            "medicamentos": ["nombre", "principio_activo"],
            "tratamientos": ["nombre", "descripcion"],
            "imagenes": ["archivo"],
            "pacientes": ["codigo_paciente"],
            "usuarios": ["nombre", "correo"],
        }.get(name, [])
        if searchable_fields:
            query_filter["$or"] = [
                {field: {"$regex": pattern, "$options": "i"}} for field in searchable_fields
            ]
    total = collection.count_documents(query_filter)
    documents = [
        serialize_document(item)
        for item in collection.find(query_filter).skip(skip).limit(limit)
    ]
    return {"items": documents, "total": total, "limit": limit, "skip": skip}


@app.post("/api/collections/{name}", status_code=201)
def create_document(name: str, payload: dict[str, Any]) -> dict[str, Any]:
    collection = _collection(name)
    document = normalize_for_mongo(payload)
    result = collection.insert_one(document)
    created = collection.find_one({"_id": result.inserted_id})
    return serialize_document(created)


@app.patch("/api/collections/{name}/{document_id}")
def update_document(name: str, document_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    if not ObjectId.is_valid(document_id):
        raise HTTPException(status_code=422, detail="El identificador debe ser un ObjectId válido.")
    if not payload or "_id" in payload:
        raise HTTPException(status_code=422, detail="Envíe campos para actualizar; _id no es modificable.")
    collection = _collection(name)
    result = collection.update_one(
        {"_id": ObjectId(document_id)}, {"$set": normalize_for_mongo(payload)}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="No se encontró el documento.")
    return serialize_document(collection.find_one({"_id": ObjectId(document_id)}))


@app.delete("/api/collections/{name}/{document_id}", status_code=204)
def delete_document(name: str, document_id: str) -> None:
    if not ObjectId.is_valid(document_id):
        raise HTTPException(status_code=422, detail="El identificador debe ser un ObjectId válido.")
    if _collection(name).delete_one({"_id": ObjectId(document_id)}).deleted_count == 0:
        raise HTTPException(status_code=404, detail="No se encontró el documento.")


@app.post("/api/documents", status_code=201)
def create_knowledge_document(payload: DocumentInput) -> dict[str, Any]:
    data = payload.model_dump()
    data["fecha"] = datetime.utcnow()
    result = _collection("documentos_conocimiento").insert_one(data)
    data["_id"] = result.inserted_id
    return serialize_document(data)


@app.post("/api/ingest", status_code=201)
def ingest_knowledge_document(payload: IngestInput) -> dict[str, Any]:
    database = get_database()
    text = payload.contenido_texto.strip()
    if not text:
        raise HTTPException(status_code=422, detail="El contenido no puede estar vacío.")
    doc = {
        "nombre_archivo": payload.nombre_archivo,
        "tipo_documento": payload.tipo_documento,
        "idioma": payload.idioma,
        "contenido_texto": text,
        "fuente": payload.fuente,
        "fecha": datetime.utcnow(),
    }
    doc_id = ObjectId()
    chunks_to_insert: list[dict[str, Any]] = []
    for strategy in payload.estrategias:
        if strategy == "semantic":
            sentences = split_sentences(text)
            vectors = embed_texts(sentences)
            chunk_texts = chunk_text(text, strategy, vectors, payload.umbral_semantico)
        else:
            chunk_texts = chunk_text(text, strategy)
        embeddings = embed_texts(chunk_texts)
        for index, (chunk, embedding) in enumerate(zip(chunk_texts, embeddings)):
            chunks_to_insert.append(
                {
                    "doc_id": doc_id,
                    "chunk_index": index,
                    "estrategia_chunking": strategy,
                    "chunk_texto": chunk,
                    "embedding": embedding,
                    "modelo": EMBEDDING_MODEL,
                    "idioma": payload.idioma,
                    "fecha": doc["fecha"],
                    "fecha_ingesta": datetime.utcnow(),
                }
            )
    database["documentos_conocimiento"].insert_one({"_id": doc_id, **doc})
    try:
        if chunks_to_insert:
            database["chunks"].insert_many(chunks_to_insert)
    except Exception:
        database["chunks"].delete_many({"doc_id": doc_id})
        database["documentos_conocimiento"].delete_one({"_id": doc_id})
        raise
    return {
        "documento_id": str(doc_id),
        "chunks_generados": len(chunks_to_insert),
        "estrategias": payload.estrategias,
        "modelo_embedding": EMBEDDING_MODEL,
    }


@app.post("/api/search")
def search(payload: SearchInput) -> dict[str, Any]:
    if payload.modo == "text":
        results = _text_search(payload)
    else:
        get_database()
        vector = embed_texts([payload.query])[0]
        results = _vector_search(vector, payload)
    return {"query": payload.query, "modo": payload.modo, "results": results}


@app.post("/api/rag")
def rag(payload: RagInput) -> dict[str, Any]:
    get_database()
    query_vector = embed_texts([payload.query])[0]
    contexts = _vector_search(query_vector, payload)
    if not contexts:
        return {"query": payload.query, "answer": "No se encontró contexto pertinente.", "sources": []}
    answer = generate_answer(payload.query, contexts)
    return {
        "query": payload.query,
        "answer": answer,
        "sources": [
            {
                "document_id": item.get("doc_id"),
                "chunk_id": item.get("_id"),
                "chunk_texto": item.get("chunk_texto"),
                "score": item.get("score"),
            }
            for item in contexts
        ],
        "disclaimer": "Información de apoyo académico; no sustituye la valoración de un profesional de salud.",
    }


@app.post("/api/images/search")
def search_similar_images(image: UploadFile = File(...), top_k: int = Query(default=5, ge=1, le=20)) -> dict[str, Any]:
    content, content_type = _read_image(image)
    get_database()
    vector = embed_image(content, content_type)
    request = SearchInput(query=image.filename or "imagen", top_k=top_k)
    return {"results": _vector_search(vector, request, "imagenes")}


@app.post("/api/images", status_code=201)
def ingest_image(
    image: UploadFile = File(...),
    diagnostico_id: str | None = Form(default=None),
    paciente_id: str | None = Form(default=None),
    region_corporal: str = Form(default="", max_length=100),
    colores: str = Form(default="", max_length=300),
    texturas: str = Form(default="", max_length=300),
) -> dict[str, Any]:
    content, content_type = _read_image(image)
    database = get_database()
    references = normalize_for_mongo(
        {"diagnostico_id": diagnostico_id, "paciente_id": paciente_id}
    )
    if references["diagnostico_id"] and database["diagnosticos_dermatologicos"].find_one(
        {"_id": references["diagnostico_id"]}, {"_id": 1}
    ) is None:
        raise HTTPException(status_code=404, detail="No se encontró el diagnóstico indicado.")
    if references["paciente_id"] and database["pacientes"].find_one(
        {"_id": references["paciente_id"]}, {"_id": 1}
    ) is None:
        raise HTTPException(status_code=404, detail="No se encontró el paciente indicado.")

    vector = embed_image(content, content_type)
    filename = image.filename or "imagen"
    bucket = GridFSBucket(database)
    file_id = bucket.upload_from_stream(
        filename,
        BytesIO(content),
        metadata={"content_type": content_type},
    )
    document = {
        "archivo": filename,
        "archivo_file_id": file_id,
        "paciente_id": references["paciente_id"],
        "diagnostico_id": references["diagnostico_id"],
        "descripcion_visual": {
            "region_corporal": region_corporal.strip(),
            "colores": [value.strip() for value in colores.split(",") if value.strip()],
            "texturas": [value.strip() for value in texturas.split(",") if value.strip()],
        },
        "embedding_visual": vector,
        "modelo_embedding": EMBEDDING_MODEL,
        "fecha_registro": datetime.utcnow(),
    }
    try:
        result = database["imagenes"].insert_one(document)
    except Exception:
        bucket.delete(file_id)
        raise
    document["_id"] = result.inserted_id
    return {
        **serialize_document(document),
        "file_url": f"/api/images/{result.inserted_id}/file",
    }


@app.get("/api/images/{image_id}/file")
def get_image_file(image_id: str) -> Response:
    if not ObjectId.is_valid(image_id):
        raise HTTPException(status_code=422, detail="El identificador debe ser un ObjectId válido.")
    document = _collection("imagenes").find_one(
        {"_id": ObjectId(image_id)}, {"archivo_file_id": 1}
    )
    if not document or not document.get("archivo_file_id"):
        raise HTTPException(status_code=404, detail="No se encontró el archivo de imagen.")
    try:
        stream = GridFSBucket(get_database()).open_download_stream(document["archivo_file_id"])
    except NoFile as exc:
        raise HTTPException(status_code=404, detail="El archivo de imagen no está disponible en GridFS.") from exc
    content_type = (stream.metadata or {}).get("content_type", "application/octet-stream")
    return Response(
        content=stream.read(),
        media_type=content_type,
        headers={"Cache-Control": "no-store"},
    )


@app.post("/api/images/search-text")
def search_images_by_text(payload: SearchInput) -> dict[str, Any]:
    get_database()
    vector = embed_texts([payload.query])[0]
    return {
        "query": payload.query,
        "results": _vector_search(vector, payload, "imagenes"),
    }


@app.get("/api/endpoints")
def endpoint_catalog() -> list[dict[str, str]]:
    return [
        {"method": "GET", "path": "/api/health", "purpose": "Verificar conexión con MongoDB."},
        {"method": "GET", "path": "/api/dashboard", "purpose": "Resumen de colecciones y volumen."},
        {"method": "GET/POST", "path": "/api/users/{id}/queries", "purpose": "Consultar o añadir al historial embebido, limitado a las últimas 50 consultas."},
        {"method": "GET", "path": "/api/diagnoses?symptoms=picazón,descamación", "purpose": "Consultar diagnósticos relacionados con síntomas."},
        {"method": "GET", "path": "/api/diagnoses/{id}/treatments", "purpose": "Consultar tratamientos y medicamentos de un diagnóstico."},
        {"method": "GET", "path": "/api/patients/{id}/history", "purpose": "Consultar historia, diagnósticos y exámenes de un paciente."},
        {"method": "GET", "path": "/api/patients/{id}/diagnosis-sequence", "purpose": "Ordenar diagnósticos por fecha y resumir transiciones observadas."},
        {"method": "GET", "path": "/api/patients/{id}/medication-risks", "purpose": "Mostrar coincidencias textuales documentadas; no es evaluación clínica."},
        {"method": "GET/POST", "path": "/api/collections/{nombre}", "purpose": "Consultar y crear registros de las colecciones."},
        {"method": "PATCH/DELETE", "path": "/api/collections/{nombre}/{id}", "purpose": "Actualizar o eliminar registros."},
        {"method": "POST", "path": "/api/documents", "purpose": "Crear un documento de conocimiento."},
        {"method": "POST", "path": "/api/ingest", "purpose": "Fragmentar, vectorizar e ingerir documentos."},
        {"method": "POST", "path": "/api/search", "purpose": "Búsqueda textual o vectorial con filtros."},
        {"method": "POST", "path": "/api/rag", "purpose": "Generar respuesta con contexto y fuentes."},
        {"method": "POST", "path": "/api/images", "purpose": "Guardar archivo en GridFS y registrar su embedding visual."},
        {"method": "GET", "path": "/api/images/{id}/file", "purpose": "Servir el archivo de imagen almacenado en GridFS."},
        {"method": "POST", "path": "/api/images/search", "purpose": "Buscar imágenes visualmente similares."},
        {"method": "POST", "path": "/api/images/search-text", "purpose": "Buscar imágenes similares a una descripción en texto."},
    ]


@app.on_event("shutdown")
def shutdown() -> None:
    close_client()
