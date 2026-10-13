"""Create project collections, validators, and regular/text indexes."""

from __future__ import annotations

import logging
import sys

from pymongo.errors import CollectionInvalid

from .mongo import COLLECTIONS, close_client, get_database

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

COLLECTION_VALIDATORS = {
    "documentos_conocimiento": {
        "$jsonSchema": {
            "bsonType": "object",
            "required": ["nombre_archivo", "tipo_documento", "idioma", "contenido_texto", "fecha"],
            "properties": {
                "nombre_archivo": {"bsonType": "string", "minLength": 1},
                "tipo_documento": {"bsonType": "string"},
                "idioma": {"bsonType": "string"},
                "contenido_texto": {"bsonType": "string", "minLength": 1},
                "fecha": {"bsonType": "date"},
            },
        }
    },
    "chunks": {
        "$jsonSchema": {
            "bsonType": "object",
            "required": [
                "doc_id",
                "chunk_index",
                "estrategia_chunking",
                "chunk_texto",
                "embedding",
                "modelo",
            ],
            "properties": {
                "doc_id": {"bsonType": "objectId"},
                "chunk_index": {"bsonType": ["int", "long"], "minimum": 0},
                "estrategia_chunking": {
                    "enum": ["fixed-size", "sentence-aware", "semantic"]
                },
                "chunk_texto": {"bsonType": "string", "minLength": 1},
                "embedding": {
                    "bsonType": "array",
                    "minItems": 1024,
                    "maxItems": 1024,
                    "items": {"bsonType": ["double", "int", "long"]},
                },
                "modelo": {"bsonType": "string"},
            },
        }
    },
    "imagenes": {
        "$jsonSchema": {
            "bsonType": "object",
            "required": ["archivo", "descripcion_visual"],
            "properties": {
                "archivo": {"bsonType": "string", "minLength": 1},
                "archivo_file_id": {"bsonType": "objectId"},
                "modelo_embedding": {"bsonType": "string"},
                "embedding_visual": {
                    "bsonType": "array",
                    "minItems": 1024,
                    "maxItems": 1024,
                    "items": {"bsonType": ["double", "int", "long"]},
                },
            },
        }
    },
}


def initialize() -> None:
    database = get_database()
    database.command("ping")
    logger.info("Conexión a MongoDB verificada (PING OK).")
    existing = set(database.list_collection_names())
    for name in COLLECTIONS:
        if name not in existing:
            options = {}
            if name in COLLECTION_VALIDATORS:
                options = {
                    "validator": COLLECTION_VALIDATORS[name],
                    "validationLevel": "strict",
                    "validationAction": "error",
                }
            try:
                database.create_collection(name, **options)
                logger.info("Colección '%s' creada.", name)
            except CollectionInvalid:
                logger.exception("No se pudo crear la colección '%s'.", name)
                raise
        elif name in COLLECTION_VALIDATORS:
            database.command(
                {
                    "collMod": name,
                    "validator": COLLECTION_VALIDATORS[name],
                    "validationLevel": "strict",
                    "validationAction": "error",
                }
            )

    database["documentos_conocimiento"].create_index(
        [("fecha", 1), ("idioma", 1)], name="idx_fecha_idioma"
    )
    database["documentos_conocimiento"].create_index(
        [("nombre_archivo", "text"), ("contenido_texto", "text")],
        name="idx_documentos_texto",
    )
    database["chunks"].create_index(
        [("doc_id", 1), ("estrategia_chunking", 1), ("chunk_index", 1)],
        unique=True,
        name="idx_chunk_documento_estrategia_posicion",
    )
    database["chunks"].create_index([("chunk_texto", "text")], name="idx_chunks_texto")
    database["imagenes"].create_index([("diagnostico_id", 1)], name="idx_imagen_diagnostico")
    database["diagnosticos_asignados"].create_index(
        [("paciente_id", 1), ("vigente", 1), ("fecha_diagnostico", -1)],
        name="idx_diagnosticos_paciente_vigencia_fecha",
    )
    database["pacientes"].create_index(
        [("codigo_paciente", 1)], unique=True, sparse=True, name="idx_codigo_paciente"
    )
    database["historias_medicas"].create_index([("paciente_id", 1)], name="idx_historia_paciente")
    database["resultados_laboratorio"].create_index(
        [("paciente_id", 1), ("fecha", -1)], name="idx_laboratorio_paciente_fecha"
    )
    logger.info("Índices normales y de texto listos.")
    logger.info(
        "En Atlas, cree también chunks_vector_index e imagenes_vector_index con "
        "1024 dimensiones y similitud cosine (configuración en docs/API_Y_PLANTILLA.md)."
    )


if __name__ == "__main__":
    try:
        initialize()
    except Exception:
        logger.exception("La inicialización de MongoDB falló.")
        sys.exit(1)
    finally:
        close_client()
