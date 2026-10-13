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
- `frontend/static/`: frontend adaptable a móvil, servido por FastAPI.
- `backend/services/file_storage.py`: staging validado de textos, imágenes y JSON para la Entrega 2.
- `data/incoming/`: carpetas de entrada; los archivos reales no se versionan.
- `backend/tests/`: pruebas unitarias para chunking.
- `docs/API_Y_PLANTILLA.md`: correspondencia detallada RF/endpoint, filtros, índices Atlas y limitaciones.

## Pruebas

```powershell
python -m unittest discover -s backend\tests -v
```

La API sirve en local para presentación académica. No usar datos reales de pacientes ni publicar el servidor: esta versión no tiene autenticación, autorización ni controles de privacidad clínica.

## Preparación de archivos para la Entrega 2

La API ofrece estas rutas multipart para preparar los lotes sin insertarlos todavía en MongoDB:

- `POST /api/uploads/texts`: `.txt` y `.md` en `data/incoming/texts/`.
- `POST /api/uploads/images`: `.jpg`, `.jpeg`, `.png` y `.webp` en `data/incoming/images/`.
- `POST /api/uploads/laboratory`: JSON UTF-8 válido en `data/incoming/laboratory/`.

La carga estructurada y la creación de `documentos_conocimiento`, `chunks` y `resultados_laboratorio` se realizará mediante un script separado en la Entrega 2.

## Índices vectoriales y datos de demostración

Para crear los índices administrados por Atlas, ejecute el script desde `mongosh`:

```powershell
mongosh "mongodb+srv://<usuario>:<password>@<cluster>/?retryWrites=true&w=majority" scripts\create_atlas_vector_indexes.js
```

El script crea `chunks_vector_index` sobre `chunks.embedding` y `imagenes_vector_index` sobre `imagenes.embedding_visual`, ambos con 1024 dimensiones y similitud coseno. No incluya la URI real en archivos del repositorio.

Para cargar datos ficticios mínimos de prueba:

```powershell
python scripts\seed_demo_data.py
```

El seeder inserta diagnósticos, síntomas, tratamientos, medicamentos, dos pacientes ficticios, historias, diagnósticos asignados, laboratorios y usuarios. No borra datos existentes ni inserta imágenes o embeddings vectoriales; esos datos requieren el flujo de ingesta y las credenciales de Jina.

## Comprobar la conexión

1. Compruebe que `.env` contiene `MONGODB_URI` y que la IP está autorizada en Atlas.
2. Ejecute `python -m backend.init_db`. Debe aparecer `Conexión a MongoDB verificada (PING OK.)`.
3. Inicie la API con `uvicorn backend.main:app --reload`.
4. En otra terminal ejecute:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/health
Invoke-RestMethod http://127.0.0.1:8000/api/dashboard
```

La primera respuesta debe indicar `"mongodb": "connected"` y la segunda debe listar las 14 colecciones. También puede abrir `http://127.0.0.1:8000/docs` y probar `GET /api/health`.
