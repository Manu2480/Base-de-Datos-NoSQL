# ENTREGA I — DermAssist

## Diseño y configuración de un sistema RAG NoSQL para información dermatológica con MongoDB

## Contenido de la entrega

- [Informe de Entrega I](guias/Entrega1_DermAssist_bdNOr_2026.md): análisis, decisiones de modelado, colecciones, índices, validación y plan de chunking.
- [Diagrama de colecciones](Diagramas/enfermedades_Dermatologicas.drawio).
- `backend/init_db.py`: creación de colecciones, validadores e índices convencionales.
- `scripts/create_atlas_vector_indexes.js`: definiciones de índices vectoriales para Atlas.
- `backend/mongo.py`: conexión a MongoDB y selección de `vector_db` por defecto.

## Requisitos y ejecución

- Python 3.10 o superior.
- MongoDB Atlas.

Desde la raíz del repositorio, en PowerShell:

```powershell
Copy-Item .env.example .env
```

Asigne localmente la URI del cluster a `MONGODB_URI` en `.env`. Luego:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r backend\requirements.txt
python -m backend.init_db
```

El inicializador ejecuta `admin.command("ping")`, crea las 14 colecciones del esquema, aplica validación `$jsonSchema` y crea los índices convencionales y de texto. No elimina documentos existentes.

Para crear los índices vectoriales administrados por Atlas:

```powershell
mongosh "<URI del cluster>" scripts\create_atlas_vector_indexes.js
```

La URI se configura de forma local y no se almacena en el repositorio. `MONGODB_DATABASE` usa `vector_db` por defecto.

## Verificación de conexión

Inicie la API local para comprobar el estado de MongoDB y consultar el esquema:

```powershell
uvicorn backend.main:app --reload
```

Abra `http://127.0.0.1:8000/api/health` y `http://127.0.0.1:8000/api/dashboard`. La primera ruta informa el estado de la conexión y la segunda lista las colecciones.

Las pruebas automatizadas del backend se ejecutan con:

```powershell
python -m unittest discover -s backend\tests -v
```

## ENTREGA II

La API ampliada, el frontend, la fragmentación/ingesta RAG, la búsqueda multimodal y sus pruebas están conservados como base de implementación para la segunda entrega. Sus archivos están identificados con la etiqueta `ENTREGA II`.
