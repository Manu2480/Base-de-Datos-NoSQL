# ENTREGA I — DermAssist

## Diseño y configuración de un sistema RAG NoSQL para información dermatológica con MongoDB

## Contenido de la entrega

- [Informe de Entrega I](guias/Entrega1_DermAssist_bdNOr_2026.md): análisis, decisiones de modelado, colecciones, índices, validación y plan de chunking.
- [Diagrama de colecciones](Diagramas/enfermedades_Dermatologicas.drawio).
- `backend/init_db.py`: creación de colecciones, validadores e índices convencionales.
- `scripts/create_atlas_vector_indexes.js`: definiciones de índices vectoriales para Atlas.
- `backend/mongo.py`: conexión a MongoDB y selección de `vector_db` por defecto.

## Datos

Todo queda en la base `vector_db`.

- `datos/conocimiento/documentos_conocimiento.json`: 179 textos para el RAG, en español e inglés. Al arrancar, `python -m backend.load_conocimiento` reemplaza `documentos_conocimiento` y enlaza cada afección con su diagnóstico clínico. Los archivos sueltos están en `datos/conocimiento/textos/` y `datos/conocimiento/textos_en/`.
- `datos/conocimiento/imagenes_referencia/`: fotografías extraídas de los artículos. El mismo cargador las guarda en `imagenes` y en GridFS, ligadas al diagnóstico. No sustituyen las imágenes de los casos clínicos.
- `datos/clinico/`: catálogo, 24 pacientes sintéticos y consultas. Compose los carga en el mismo Mongo de la API. El uso está en [datos/clinico/README.md](datos/clinico/README.md).
- `datos/imagenes/`: reservada. Las fotos de los casos clínicos siguen con un embedding sintético; las fotografías reales están en `imagenes_referencia`.

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

Para dejar el catálogo, los pacientes y los textos en el mismo cluster:

```powershell
mongosh "<URI del cluster>" datos/clinico/init/01-esquema.js datos/clinico/init/02-catalogo.js datos/clinico/init/03-pacientes.js
python -m backend.load_conocimiento
```

`01-esquema.js` borra y vuelve a crear las colecciones clínicas. No borra `documentos_conocimiento`, `chunks`, `usuarios`, `consultas` ni `evaluaciones`.

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

## Ejecución con Docker en Fedora

Desde la raíz del repositorio, con Docker Engine y el complemento Docker Compose instalados:

```bash
docker compose up --build -d
docker compose ps
```

La API queda disponible en <http://localhost:8000>; la documentación interactiva está en <http://localhost:8000/docs>. Compose inicia MongoDB, carga el catálogo clínico en `vector_db` si todavía no está y, al arrancar la API, crea los índices y carga los 116 textos enlazados a cada diagnóstico. Para ver los registros o detener los servicios:

```bash
docker compose logs -f
docker compose down
```

`docker compose down` conserva el volumen. Para volver a cargar el catálogo desde cero, use `docker compose down -v`.

Por defecto se usa el MongoDB local del contenedor. Esta opción sirve para la API y las búsquedas convencionales; MongoDB Community no ofrece los índices `$vectorSearch` de Atlas. Para habilitar las búsquedas vectoriales, configure `DOCKER_MONGODB_URI` en el archivo `.env` con la URI de Atlas antes de iniciar Compose y cree allí los índices vectoriales siguiendo [scripts/create_atlas_vector_indexes.js](scripts/create_atlas_vector_indexes.js). En ese caso también hay que ejecutar en Atlas los scripts de `datos/clinico/init/` y `python -m backend.load_conocimiento`: el cargador de Compose solo llena el Mongo del contenedor. La URI de Docker tiene prioridad sobre `MONGODB_URI` para no cambiar la configuración de ejecución local.

La ingesta que genera embeddings requiere `JINA_API_KEY`; las respuestas RAG también requieren `GROQ_API_KEY`. Añada esos valores al `.env` si va a usar esas funciones. No publique ese archivo ni lo incluya en la imagen Docker.

## ENTREGA II

La API ampliada, el frontend, la fragmentación/ingesta RAG, la búsqueda multimodal y sus pruebas están conservados como base de implementación para la segunda entrega. Sus archivos están identificados con la etiqueta `ENTREGA II`.
