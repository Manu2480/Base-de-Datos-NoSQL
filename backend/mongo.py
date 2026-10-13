"""MongoDB connection and BSON/JSON conversion helpers."""

from __future__ import annotations

import os
from datetime import datetime
from typing import Any

from bson import ObjectId
from dotenv import load_dotenv
from fastapi import HTTPException
from pymongo import MongoClient
from pymongo.database import Database

load_dotenv()

COLLECTIONS = (
    "usuarios",
    "documentos_conocimiento",
    "imagenes",
    "chunks",
    "consultas",
    "evaluaciones",
    "diagnosticos_dermatologicos",
    "sintomas",
    "medicamentos",
    "tratamientos",
    "diagnosticos_asignados",
    "pacientes",
    "historias_medicas",
    "resultados_laboratorio",
)

_client: MongoClient | None = None


def get_database() -> Database:
    global _client
    uri = os.getenv("MONGODB_URI")
    if not uri:
        raise HTTPException(
            status_code=503,
            detail="MongoDB no está configurado. Defina MONGODB_URI en el archivo .env.",
        )
    if _client is None:
        try:
            _client = MongoClient(uri, serverSelectionTimeoutMS=4000)
            _client.admin.command("ping")
        except Exception as exc:
            _client = None
            raise HTTPException(
                status_code=503,
                detail="No se pudo conectar con MongoDB. Revise MONGODB_URI y la lista de IP permitidas.",
            ) from exc
    return _client[os.getenv("MONGODB_DATABASE", "vector_db")]


def close_client() -> None:
    global _client
    if _client is not None:
        _client.close()
        _client = None


def normalize_for_mongo(value: Any, field: str = "") -> Any:
    if isinstance(value, dict):
        return {key: normalize_for_mongo(item, key) for key, item in value.items()}
    if isinstance(value, list):
        if field.endswith("_ids"):
            return [normalize_for_mongo(item, field[:-1]) for item in value]
        return [normalize_for_mongo(item) for item in value]
    if isinstance(value, str) and (field == "_id" or field.endswith("_id")):
        if not ObjectId.is_valid(value):
            raise HTTPException(status_code=422, detail=f"'{field}' debe ser un ObjectId hexadecimal válido.")
        return ObjectId(value)
    if isinstance(value, str) and (field == "fecha" or field.endswith("_fecha") or field.startswith("fecha_")):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=f"'{field}' debe ser una fecha ISO válida.") from exc
    return value


def serialize_document(value: Any) -> Any:
    if isinstance(value, ObjectId):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {key: serialize_document(item) for key, item in value.items()}
    if isinstance(value, list):
        return [serialize_document(item) for item in value]
    return value
