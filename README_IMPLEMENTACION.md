# DermAssist: backend y frontend

Prototipo académico para el proyecto de sistema RAG dermatológico con MongoDB. Incluye interfaz web, API FastAPI, CRUD sobre el esquema documental, ingesta con tres estrategias de chunking, búsqueda de texto/vector, respuestas RAG con fuentes e ingesta/similitud multimodal de imágenes usando GridFS y Atlas Vector Search.

## Requisitos

- Python 3.10 o superior.
- MongoDB Atlas recomendado para `$vectorSearch`; el notebook original usa la base `vector_db`.
- Credenciales opcionales de Jina y Groq para las funciones que llaman esos servicios.

## Ejecutar en Windows

Desde la carpeta raíz del repositorio, en PowerShell:

```powershell
Copy-Item .env.example .env
# Editar .env y asignar MONGODB_URI con la URI privada del cluster.
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r backend\requirements.txt
python -m backend.init_db
uvicorn backend.main:app --reload
```

Abrir `http://127.0.0.1:8000/`. La documentación interactiva está en `http://127.0.0.1:8000/docs`.

`MONGODB_DATABASE` usa `vector_db` por defecto. No se requiere un valor de `JINA_API_KEY` para ejecutar la aplicación y consultar datos existentes o probar búsqueda textual. La ingesta, búsqueda semántica y similitud de imágenes requieren Jina; `POST /api/rag` requiere además Groq. Configure las claves localmente en `.env`.

El notebook `Scrips COLAB\script Inicializacion.ipynb` contiene un URI que no debe copiarse al código ni compartirse. Usa PyMongo, comprueba la conexión con `admin.command("ping")` y selecciona `vector_db`; esta aplicación conserva ese patrón y lee la URI desde variable de entorno. No se reutilizan ni exponen credenciales.

## Estructura

- `backend/main.py`: rutas HTTP y API.
- `backend/mongo.py`: conexión PyMongo, colecciones, conversión BSON.
- `backend/init_db.py`: colecciones, validación JSON Schema e índices.
- `backend/chunking.py`: fixed-size, sentence-aware y semantic.
- `backend/ai.py`: cliente HTTP para embeddings Jina y LLM Groq.
- `backend/static/`: frontend adaptable a móvil, servido por FastAPI.
- `backend/tests/`: pruebas unitarias para chunking.
- `docs/API_Y_PLANTILLA.md`: correspondencia detallada RF/endpoint, filtros, índices Atlas y limitaciones.

## Pruebas

```powershell
python -m unittest discover -s backend\tests -v
```

La API sirve en local para presentación académica. No usar datos reales de pacientes ni publicar el servidor: esta versión no tiene autenticación, autorización ni controles de privacidad clínica.
