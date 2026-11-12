"""Consultas y altas clínicas sobre las colecciones de vector_db.

Cada consulta tiene su propia ruta. Los filtros usan atributos que existen
en el esquema: no hay un filtro genérico sobre campos arbitrarios.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Literal

from bson import ObjectId
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from pymongo.errors import DuplicateKeyError

from .mongo import get_database, serialize_document

router = APIRouter()

LIST_LIMIT = 40
CATALOG_LIMIT = 500


def _blank(value: str | None) -> str | None:
    if value is None:
        return None
    text = value.strip()
    return text or None


def _contains(value: str | None) -> dict[str, str] | None:
    text = _blank(value)
    if not text:
        return None
    return {"$regex": re.escape(text), "$options": "i"}


def _object_id(value: str | None, label: str) -> ObjectId | None:
    text = _blank(value)
    if text is None:
        return None
    if not ObjectId.is_valid(text):
        raise HTTPException(status_code=422, detail=f"{label} debe ser un ObjectId hexadecimal válido.")
    return ObjectId(text)


def _required_id(value: str, label: str) -> ObjectId:
    parsed = _object_id(value, label)
    if parsed is None:
        raise HTTPException(status_code=422, detail=f"{label} es obligatorio.")
    return parsed


def _parse_date(value: str, label: str) -> datetime:
    text = value.strip()
    if len(text) == 10:
        text = f"{text}T00:00:00+00:00"
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"{label} debe ser una fecha ISO (AAAA-MM-DD).") from exc
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def _find_page(
    collection: str,
    query: dict[str, Any],
    projection: dict[str, int] | None = None,
    sort: list | None = None,
    limit: int = LIST_LIMIT,
) -> dict[str, Any]:
    cursor = get_database()[collection].find(query, projection)
    if sort:
        cursor = cursor.sort(sort)
    documents = [serialize_document(item) for item in cursor.limit(limit)]
    return {"total_devuelto": len(documents), "limite": limit, "items": documents}


def _next_patient_code(database) -> str:
    highest = 0
    for item in database["pacientes"].find(
        {"codigo_paciente": {"$regex": r"^DERM-\d+$"}},
        {"codigo_paciente": 1},
    ):
        number = int(str(item["codigo_paciente"]).split("-", 1)[1])
        if number > highest:
            highest = number
    return f"DERM-{highest + 1:04d}"


class AllergyInput(BaseModel):
    sustancia: str = Field(min_length=1, max_length=120)
    reaccion: str = Field(default="", max_length=240)

    @field_validator("sustancia")
    @classmethod
    def strip_substance(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("La sustancia no puede estar vacía.")
        return text


class ResidenceInput(BaseModel):
    pais: str = Field(min_length=1, max_length=80)
    ciudad: str = Field(min_length=1, max_length=80)


class PatientCreate(BaseModel):
    nombre_completo: str = Field(min_length=1, max_length=160)
    fecha_nacimiento: str
    lugar_residencia: ResidenceInput
    alergias: list[AllergyInput] = Field(default_factory=list)


class UserCreate(BaseModel):
    nombre: str = Field(min_length=1, max_length=160)
    correo: str = Field(min_length=3, max_length=160)


class HistoryCreate(BaseModel):
    fecha: str
    observaciones: str = Field(default="", max_length=2000)


class AssignedDiagnosisCreate(BaseModel):
    historia_medica_id: str
    diagnostico_id: str | None = None
    fecha_diagnostico: str
    vigente: bool = True
    observaciones: str = Field(default="", max_length=2000)
    sintomas_ids: list[str] = Field(default_factory=list)

    @field_validator("diagnostico_id")
    @classmethod
    def blank_diagnosis(cls, value: str | None) -> str | None:
        if value is None:
            return None
        text = value.strip()
        return text or None


class LabValue(BaseModel):
    parametro: str = Field(min_length=1, max_length=160)
    valor: str = Field(min_length=1, max_length=240)
    observaciones: str = Field(default="", max_length=500)


class LaboratoryCreate(BaseModel):
    historia_medica_id: str
    fecha: str
    tipo_examen: str = Field(min_length=1, max_length=160)
    formato: Literal["JSON", "TXT"]
    resultado: LabValue


def _patient_or_404(patient_id: ObjectId) -> dict[str, Any]:
    patient = get_database()["pacientes"].find_one({"_id": patient_id})
    if patient is None:
        raise HTTPException(status_code=404, detail="No se encontró el paciente.")
    return patient


def _history_for_patient(patient_id: ObjectId, history_id: ObjectId) -> dict[str, Any]:
    history = get_database()["historias_medicas"].find_one({"_id": history_id})
    if history is None or history.get("paciente_id") != patient_id:
        raise HTTPException(status_code=404, detail="La historia no pertenece a este paciente.")
    if not history.get("episodios"):
        raise HTTPException(status_code=422, detail="La historia no tiene episodios a los cuales asociar el registro.")
    return history


@router.get("/api/patients")
def list_patients(
    codigo: str | None = Query(default=None, max_length=40),
    nombre: str | None = Query(default=None, max_length=160),
    ciudad: str | None = Query(default=None, max_length=80),
    alergia: str | None = Query(default=None, max_length=120),
    solo_vivos: bool = False,
) -> dict[str, Any]:
    query: dict[str, Any] = {}
    if (code := _contains(codigo)):
        query["codigo_paciente"] = code
    if (name := _contains(nombre)):
        query["nombre_completo"] = name
    if (city := _contains(ciudad)):
        query["lugar_residencia.ciudad"] = city
    if (allergy := _contains(alergia)):
        query["alergias.sustancia"] = allergy
    if solo_vivos:
        query["$or"] = [{"fecha_defuncion": None}, {"fecha_defuncion": {"$exists": False}}]
    return _find_page("pacientes", query, sort=[("nombre_completo", 1)])


@router.get("/api/patients/{patient_id}/profile")
def patient_profile(patient_id: str) -> dict[str, Any]:
    reference = _required_id(patient_id, "El paciente")
    database = get_database()
    patient = _patient_or_404(reference)
    histories = list(database["historias_medicas"].find({"paciente_id": reference}))
    assigned = list(
        database["diagnosticos_asignados"].find({"paciente_id": reference}).sort("fecha_diagnostico", -1)
    )
    diagnosis_ids = list({item.get("diagnostico_id") for item in assigned if item.get("diagnostico_id")})
    diagnoses = {
        item["_id"]: item
        for item in database["diagnosticos_dermatologicos"].find(
            {"_id": {"$in": diagnosis_ids}},
            {"nombre": 1, "categoria": 1, "sintomas_ids": 1},
        )
    }
    symptom_ids = [
        symptom_id
        for item in assigned
        for symptom_id in item.get("sintomas_ids", [])
    ]
    symptoms = {
        item["_id"]: item.get("nombre")
        for item in database["sintomas"].find({"_id": {"$in": symptom_ids}}, {"nombre": 1})
    }
    for item in assigned:
        diagnosis = diagnoses.get(item.get("diagnostico_id"))
        item["diagnostico"] = {"nombre": diagnosis.get("nombre"), "categoria": diagnosis.get("categoria")} if diagnosis else None
        item["sintomas"] = [symptoms.get(symptom_id) for symptom_id in item.get("sintomas_ids", []) if symptoms.get(symptom_id)]
    laboratories = list(
        database["resultados_laboratorio"].find({"paciente_id": reference}).sort("fecha", -1)
    )
    images = list(
        database["imagenes"].find(
            {"paciente_id": reference},
            {"embedding_visual": 0},
        ).sort("fecha_registro", -1)
    )
    return {
        "patient": serialize_document(patient),
        "medical_histories": [serialize_document(item) for item in histories],
        "assigned_diagnoses": [serialize_document(item) for item in assigned],
        "laboratory_results": [serialize_document(item) for item in laboratories],
        "images": [serialize_document(item) for item in images],
    }


@router.post("/api/patients", status_code=201)
def create_patient(payload: PatientCreate) -> dict[str, Any]:
    database = get_database()
    document = {
        "nombre_completo": payload.nombre_completo.strip(),
        "fecha_nacimiento": _parse_date(payload.fecha_nacimiento, "La fecha de nacimiento"),
        "fecha_defuncion": None,
        "lugar_residencia": payload.lugar_residencia.model_dump(),
        "alergias": [item.model_dump() for item in payload.alergias],
        "diagnosticos_asignados_ids": [],
        "historias_clinicas_ids": [],
    }
    for _ in range(5):
        document["codigo_paciente"] = _next_patient_code(database)
        try:
            result = database["pacientes"].insert_one(document)
            break
        except DuplicateKeyError:
            continue
    else:
        raise HTTPException(status_code=409, detail="No se pudo asignar un código de paciente.")
    document["_id"] = result.inserted_id
    return serialize_document(document)


@router.post("/api/users", status_code=201)
def create_user(payload: UserCreate) -> dict[str, Any]:
    document = {
        "nombre": payload.nombre.strip(),
        "correo": payload.correo.strip(),
        "historial_consultas": [],
    }
    result = get_database()["usuarios"].insert_one(document)
    document["_id"] = result.inserted_id
    return serialize_document(document)


@router.post("/api/patients/{patient_id}/histories", status_code=201)
def create_history(patient_id: str, payload: HistoryCreate) -> dict[str, Any]:
    reference = _required_id(patient_id, "El paciente")
    _patient_or_404(reference)
    when = _parse_date(payload.fecha, "La fecha del episodio")
    document = {
        "paciente_id": reference,
        "episodios": [
            {
                "fecha": when,
                "observaciones": payload.observaciones.strip(),
                "diagnosticos_asignados_ids": [],
                "imagenes_ids": [],
                "resultados_laboratorio_ids": [],
            }
        ],
    }
    database = get_database()
    result = database["historias_medicas"].insert_one(document)
    database["pacientes"].update_one(
        {"_id": reference},
        {"$addToSet": {"historias_clinicas_ids": result.inserted_id}},
    )
    document["_id"] = result.inserted_id
    return serialize_document(document)


@router.post("/api/patients/{patient_id}/assigned-diagnoses", status_code=201)
def assign_diagnosis(patient_id: str, payload: AssignedDiagnosisCreate) -> dict[str, Any]:
    reference = _required_id(patient_id, "El paciente")
    history_id = _required_id(payload.historia_medica_id, "La historia")
    diagnosis_id = _object_id(payload.diagnostico_id, "El diagnóstico")
    _patient_or_404(reference)
    history = _history_for_patient(reference, history_id)
    database = get_database()
    if diagnosis_id is not None and database["diagnosticos_dermatologicos"].find_one({"_id": diagnosis_id}, {"_id": 1}) is None:
        raise HTTPException(status_code=404, detail="No se encontró el diagnóstico del catálogo.")
    symptom_ids = [_required_id(item, "Cada síntoma") for item in payload.sintomas_ids]
    if symptom_ids:
        found = database["sintomas"].count_documents({"_id": {"$in": symptom_ids}})
        if found != len(set(symptom_ids)):
            raise HTTPException(status_code=422, detail="Hay síntomas que no existen en el catálogo.")
    when = _parse_date(payload.fecha_diagnostico, "La fecha del diagnóstico")
    document = {
        "paciente_id": reference,
        "historia_medica_id": history_id,
        "episodio_fecha": history["episodios"][-1].get("fecha") or when,
        "diagnostico_id": diagnosis_id,
        "fecha_diagnostico": when,
        "vigente": payload.vigente,
        "observaciones": payload.observaciones.strip(),
        "tratamientos_asignados": [],
        "sintomas_ids": symptom_ids,
    }
    result = database["diagnosticos_asignados"].insert_one(document)
    episode_index = len(history["episodios"]) - 1
    database["historias_medicas"].update_one(
        {"_id": history_id},
        {"$push": {f"episodios.{episode_index}.diagnosticos_asignados_ids": result.inserted_id}},
    )
    database["pacientes"].update_one(
        {"_id": reference},
        {"$addToSet": {"diagnosticos_asignados_ids": result.inserted_id}},
    )
    document["_id"] = result.inserted_id
    return serialize_document(document)


@router.post("/api/patients/{patient_id}/laboratory", status_code=201)
def create_laboratory(patient_id: str, payload: LaboratoryCreate) -> dict[str, Any]:
    reference = _required_id(patient_id, "El paciente")
    history_id = _required_id(payload.historia_medica_id, "La historia")
    _patient_or_404(reference)
    history = _history_for_patient(reference, history_id)
    when = _parse_date(payload.fecha, "La fecha del examen")
    document = {
        "paciente_id": reference,
        "historia_medica_id": history_id,
        "fecha": when,
        "tipo_examen": payload.tipo_examen.strip(),
        "formato": payload.formato,
        "resultado": payload.resultado.model_dump(),
    }
    database = get_database()
    result = database["resultados_laboratorio"].insert_one(document)
    episode_index = len(history["episodios"]) - 1
    database["historias_medicas"].update_one(
        {"_id": history_id},
        {"$push": {f"episodios.{episode_index}.resultados_laboratorio_ids": result.inserted_id}},
    )
    document["_id"] = result.inserted_id
    return serialize_document(document)


@router.get("/api/symptoms")
def list_symptoms(nombre: str | None = Query(default=None, max_length=120)) -> dict[str, Any]:
    query = {}
    if (name := _contains(nombre)):
        query["nombre"] = name
    return _find_page("sintomas", query, sort=[("nombre", 1)], limit=CATALOG_LIMIT)


@router.get("/api/diagnosis-catalog")
def list_diagnosis_catalog(
    nombre: str | None = Query(default=None, max_length=160),
    categoria: str | None = Query(default=None, max_length=160),
) -> dict[str, Any]:
    query: dict[str, Any] = {}
    if (name := _contains(nombre)):
        query["nombre"] = name
    if (category := _contains(categoria)):
        query["categoria"] = category
    return _find_page(
        "diagnosticos_dermatologicos",
        query,
        {"nombre": 1, "categoria": 1, "descripcion": 1, "sintomas_ids": 1},
        [("nombre", 1)],
        limit=CATALOG_LIMIT,
    )


@router.get("/api/treatments")
def list_treatments(
    nombre: str | None = Query(default=None, max_length=160),
    diagnostico_id: str | None = Query(default=None, max_length=32),
) -> dict[str, Any]:
    query: dict[str, Any] = {}
    if (name := _contains(nombre)):
        query["nombre"] = name
    if (diagnosis := _object_id(diagnostico_id, "diagnostico_id")):
        query["diagnosticos_ids"] = diagnosis
    return _find_page("tratamientos", query, sort=[("nombre", 1)])


@router.get("/api/medications")
def list_medications(
    nombre: str | None = Query(default=None, max_length=160),
    principio_activo: str | None = Query(default=None, max_length=160),
) -> dict[str, Any]:
    query: dict[str, Any] = {}
    if (name := _contains(nombre)):
        query["nombre"] = name
    if (ingredient := _contains(principio_activo)):
        query["principio_activo"] = ingredient
    return _find_page("medicamentos", query, sort=[("nombre", 1)])


@router.get("/api/assigned-diagnoses")
def list_assigned_diagnoses(
    paciente_id: str | None = Query(default=None, max_length=32),
    diagnostico_id: str | None = Query(default=None, max_length=32),
    vigente: bool | None = None,
) -> dict[str, Any]:
    query: dict[str, Any] = {}
    if (patient := _object_id(paciente_id, "paciente_id")):
        query["paciente_id"] = patient
    if (diagnosis := _object_id(diagnostico_id, "diagnostico_id")):
        query["diagnostico_id"] = diagnosis
    if vigente is not None:
        query["vigente"] = vigente
    return _find_page("diagnosticos_asignados", query, sort=[("fecha_diagnostico", -1)])


@router.get("/api/medical-histories")
def list_histories(paciente_id: str | None = Query(default=None, max_length=32)) -> dict[str, Any]:
    query = {}
    if (patient := _object_id(paciente_id, "paciente_id")):
        query["paciente_id"] = patient
    return _find_page("historias_medicas", query)


@router.get("/api/laboratory-results")
def list_laboratory(
    paciente_id: str | None = Query(default=None, max_length=32),
    tipo_examen: str | None = Query(default=None, max_length=160),
    formato: Literal["JSON", "TXT"] | None = None,
    fecha_desde: str | None = Query(default=None, max_length=40),
    fecha_hasta: str | None = Query(default=None, max_length=40),
) -> dict[str, Any]:
    query: dict[str, Any] = {}
    if (patient := _object_id(paciente_id, "paciente_id")):
        query["paciente_id"] = patient
    if (exam := _contains(tipo_examen)):
        query["tipo_examen"] = exam
    if formato:
        query["formato"] = formato
    if fecha_desde or fecha_hasta:
        dates: dict[str, datetime] = {}
        if fecha_desde:
            dates["$gte"] = _parse_date(fecha_desde, "fecha_desde")
        if fecha_hasta:
            dates["$lte"] = _parse_date(fecha_hasta, "fecha_hasta")
        query["fecha"] = dates
    return _find_page("resultados_laboratorio", query, sort=[("fecha", -1)])


@router.get("/api/clinical-images")
def list_clinical_images(
    diagnostico: str | None = Query(default=None, max_length=160),
    pdf_origen: str | None = Query(default=None, max_length=200),
    pie: str | None = Query(default=None, max_length=200),
    pagina: int | None = Query(default=None, ge=1, le=5000),
) -> dict[str, Any]:
    """Photographs that have a stored file.

    The reference set has diagnostico_id, pdf_origen, pie_figura and pagina.
    It has no patient and no body-region field, so those are not filters here.
    """
    query: dict[str, Any] = {"archivo_file_id": {"$exists": True, "$ne": None}}
    if (name := _contains(diagnostico)):
        diagnosis_ids = [
            item["_id"]
            for item in get_database()["diagnosticos_dermatologicos"].find(
                {"nombre": name},
                {"_id": 1},
            )
        ]
        query["$or"] = [
            {"diagnostico_id": {"$in": diagnosis_ids}},
            {"diagnosticos_ids": {"$in": diagnosis_ids}},
        ]
    if (source := _contains(pdf_origen)):
        query["pdf_origen"] = source
    if (caption := _contains(pie)):
        query["pie_figura"] = caption
    if pagina is not None:
        query["pagina"] = pagina
    page = _find_page(
        "imagenes",
        query,
        {"embedding_visual": 0},
        [("fecha_registro", -1)],
    )
    id_strings = {
        item["diagnostico_id"]
        for item in page["items"]
        if isinstance(item.get("diagnostico_id"), str) and ObjectId.is_valid(item["diagnostico_id"])
    }
    names = {
        str(item["_id"]): item.get("nombre", "")
        for item in get_database()["diagnosticos_dermatologicos"].find(
            {"_id": {"$in": [ObjectId(value) for value in id_strings]}},
            {"nombre": 1},
        )
    }
    for item in page["items"]:
        item["diagnostico"] = names.get(item.get("diagnostico_id"), "")
    return page


@router.get("/api/knowledge-documents")
def list_knowledge(
    tema: str | None = Query(default=None, max_length=80),
    categoria: str | None = Query(default=None, max_length=40),
    idioma: str | None = Query(default=None, max_length=8),
    diagnostico_id: str | None = Query(default=None, max_length=32),
) -> dict[str, Any]:
    query: dict[str, Any] = {}
    if (topic := _contains(tema)):
        query["tema"] = topic
    if (category := _contains(categoria)):
        query["categoria"] = category
    if (language := _blank(idioma)):
        query["idioma"] = language
    if (diagnosis := _object_id(diagnostico_id, "diagnostico_id")):
        query["diagnostico_id"] = diagnosis
    return _find_page(
        "documentos_conocimiento",
        query,
        {"contenido_texto": 0},
        [("tema", 1), ("categoria", 1)],
    )


@router.get("/api/chunks")
def list_chunks(
    doc_id: str | None = Query(default=None, max_length=32),
    estrategia_chunking: Literal["fixed-size", "sentence-aware", "semantic"] | None = None,
    idioma: str | None = Query(default=None, max_length=8),
) -> dict[str, Any]:
    query: dict[str, Any] = {}
    if (document_id := _object_id(doc_id, "doc_id")):
        query["doc_id"] = document_id
    if estrategia_chunking:
        query["estrategia_chunking"] = estrategia_chunking
    if (language := _blank(idioma)):
        query["idioma"] = language
    return _find_page("chunks", query, {"embedding": 0}, [("doc_id", 1), ("chunk_index", 1)])


@router.get("/api/users")
def list_users(
    nombre: str | None = Query(default=None, max_length=160),
    correo: str | None = Query(default=None, max_length=160),
) -> dict[str, Any]:
    query: dict[str, Any] = {}
    if (name := _contains(nombre)):
        query["nombre"] = name
    if (email := _contains(correo)):
        query["correo"] = email
    return _find_page("usuarios", query, {"historial_consultas": 0}, [("nombre", 1)])


@router.get("/api/stored-queries")
def list_stored_queries() -> dict[str, Any]:
    return _find_page("consultas", {})


@router.get("/api/evaluations")
def list_evaluations() -> dict[str, Any]:
    return _find_page("evaluaciones", {})
