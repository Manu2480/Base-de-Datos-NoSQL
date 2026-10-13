# API y correspondencia con la Entrega 1

## API para la plantilla

La aplicación usa FastAPI y PyMongo; el nombre de base por defecto es `vector_db`, el mismo que en el notebook `script Inicializacion`. La URI se lee de `MONGODB_URI` y nunca se escribe en el código.

| RF de la plantilla | Endpoint implementado | Operación y colecciones |
|---|---|---|
| RF-01. Búsqueda semántica sobre contenido | `POST /api/search` con `modo: "vector"` | `$vectorSearch` en `chunks.embedding`. |
| RF-02. Filtros de idioma y fecha | `POST /api/search` con `idioma`, `fecha_desde`, `fecha_hasta` | `$vectorSearch` con filtros Atlas por idioma, estrategia y fecha. |
| RF-03. Búsqueda de texto completo | `POST /api/search` con `modo: "text"` | Índice de texto sobre `chunks.chunk_texto`; usa regex escapada si el índice aún no está creado. |
| RF-04. Búsqueda de imágenes similares | `POST /api/images/search` (multipart `image`) o `POST /api/images/search-text` | Jina CLIP + `$vectorSearch` sobre `imagenes.embedding_visual`; soporta imagen-a-imagen y texto-a-imagen. |
| RF-05. Respuesta generada con contexto | `POST /api/rag` | Recupera chunks, envía el contexto a Groq y devuelve respuesta y fuentes. |
| RF-06. Historial de consultas por usuario | `GET/POST /api/users/{id}/queries` | Lee/escribe el arreglo embebido `usuarios.historial_consultas`, acotado a las últimas 50 consultas. |

## Requerimientos clínicos descritos en el informe del grupo

| Requerimiento del informe | Endpoint implementado | Operación y colecciones |
|---|---|---|
| Buscar afecciones por síntomas | `GET /api/diagnoses?symptoms=picazón,descamación` | Busca `sintomas` y consulta `diagnosticos_dermatologicos.sintomas_ids`. |
| Consultar tratamientos de una afección | `GET /api/diagnoses/{id}/treatments` | Consulta `tratamientos.diagnosticos_ids` y resuelve `medicamentos`. |
| Analizar secuencias de diagnósticos | `GET /api/patients/{id}/diagnosis-sequence` | Ordena `diagnosticos_asignados` y resume transiciones observadas. |
| Consultar historia clínica | `GET /api/patients/{id}/history` | Lee paciente, historias, diagnósticos asignados y laboratorios. |
| Mostrar posibles coincidencias de alergias | `GET /api/patients/{id}/medication-risks` | Comparación textual; no descarta riesgos ni entrega decisión clínica. |
| Crear, consultar, actualizar y eliminar entidades | `GET/POST /api/collections/{nombre}`; `PATCH/DELETE /api/collections/{nombre}/{id}` | CRUD sobre colecciones habilitadas. |
| Ingresar una imagen para formar el catálogo | `POST /api/images` (multipart `image`, metadata opcional) | Guarda el archivo en GridFS y su embedding visual de 1024 dimensiones en `imagenes`. |
| Estado y conectividad | `GET /api/health`, `GET /api/dashboard` | Comprueba el ping de MongoDB y cuenta los documentos de cada colección. |

`GET /api/endpoints` entrega el catálogo para consumo programático; la interfaz de usuario está en `/` y Swagger UI en `/docs`.

### Ejemplos de petición

```json
POST /api/search
{
  "query": "¿Qué manifestaciones se asocian con psoriasis?",
  "modo": "vector",
  "estrategia_chunking": "sentence-aware",
  "idioma": "es",
  "top_k": 5
}
```

```json
POST /api/ingest
{
  "nombre_archivo": "guia-dermatologica.txt",
  "tipo_documento": "Texto",
  "idioma": "es",
  "fuente": "Referencia del documento",
  "contenido_texto": "Texto de conocimiento con contenido suficiente para fragmentar.",
  "estrategias": ["fixed-size", "sentence-aware", "semantic"],
  "umbral_semantico": 0.8
}
```

```json
POST /api/rag
{
  "query": "¿Qué dice la fuente sobre esta afección?",
  "estrategia_chunking": "semantic",
  "idioma": "es",
  "top_k": 5
}
```

La ingesta usa tres estrategias configurables. Para mantener dependencias livianas, `fixed-size` delimita 256 unidades separadas por espacios con 32 de solapamiento (aproximación de palabras, no el tokenizador de Jina); `sentence-aware` agrupa hasta cinco oraciones con una de solapamiento; `semantic` compara embeddings Jina CLIP de oraciones consecutivas con umbral 0.8 y tope de 256 palabras. Si el docente exige conteo exacto de tokens, se debe sustituir la aproximación `fixed-size` por el tokenizador de Jina y registrar ese cambio en el experimento.

## Inicialización e índices

`backend/init_db.py` comprueba la conexión con `ping`, crea la unión de las 11 colecciones del informe y `usuarios`, `consultas` y `evaluaciones` de la plantilla (14 en total; `evaluaciones` queda disponible para RAGAS), y aplica validadores `$jsonSchema` a `documentos_conocimiento`, `chunks` e `imagenes`. También crea índices de fecha/idioma, texto y referencias. La inicialización no elimina ni sobrescribe documentos existentes.

En MongoDB Atlas, después de ejecutar el script, cree en **Database > Search & Vector Search** estos índices:

**`chunks_vector_index`**, colección `chunks`:

```json
{
  "fields": [
    {"type": "vector", "path": "embedding", "numDimensions": 1024, "similarity": "cosine"},
    {"type": "filter", "path": "estrategia_chunking"},
    {"type": "filter", "path": "idioma"},
    {"type": "filter", "path": "fecha"}
  ]
}
```

**`imagenes_vector_index`**, colección `imagenes`:

```json
{
  "fields": [
    {"type": "vector", "path": "embedding_visual", "numDimensions": 1024, "similarity": "cosine"},
    {"type": "filter", "path": "diagnostico_id"},
    {"type": "filter", "path": "paciente_id"}
  ]
}
```

Los vectores deben generarse con `jina-clip-v2` y tener 1024 dimensiones, como se establece en el informe del grupo. `POST /api/images` guarda el binario en GridFS y los metadatos, referencias y embedding en `imagenes`; `GET /api/images/{id}/file` recupera la imagen. MongoDB local permite CRUD y búsqueda textual, pero no habilita estos índices Atlas Vector Search; la búsqueda vectorial responderá `503` si el índice no existe.

**Consistencia entre documentos:** el ejemplo de la plantilla incluye 384 dimensiones y `all-MiniLM-L6-v2`, mientras el informe del grupo selecciona `jina-clip-v2` con 1024 dimensiones para compartir espacio vectorial entre texto e imágenes. Esta implementación sigue el modelo acordado en el informe; actualicen el ejemplo/índice de la plantilla a 1024 dimensiones para que no queden especificaciones contradictorias.

## Correspondencia con patrones de acceso

| Patrón | Endpoint |
|---|---|
| Top-k de chunks por similitud, estrategia e idioma | `POST /api/search` (`modo=vector`) |
| Recuperación filtrada por rango de fecha | `POST /api/search` (`fecha_desde`, `fecha_hasta`) |
| Recuperación léxica de chunks | `POST /api/search` (`modo=text`) |
| Recuperar tratamiento y medicamentos por diagnóstico | `GET /api/diagnoses/{id}/treatments` |
| Recuperar historia y episodios de paciente | `GET /api/patients/{id}/history` |
| Buscar imágenes desde una imagen o descripción | `POST /api/images/search` / `POST /api/images/search-text` |
| Guardar las últimas 50 consultas de un usuario | `GET/POST /api/users/{id}/queries` |
| Responder con contexto y trazabilidad de fuentes | `POST /api/rag` |
| Comparar estrategias con las mismas consultas | Ejecutar `POST /api/search` y `POST /api/rag` con `estrategia_chunking` fijo para cada variante |

## Configuración segura y limitaciones

- No suba `.env` ni credenciales al repositorio. Use `.env.example` como referencia.
- Jina y Groq son servicios externos: configure `JINA_API_KEY` para embeddings y `GROQ_API_KEY` para generación RAG. Sin credenciales o índice disponible, la API devuelve errores explícitos `503`/`502`.
- El contenido de ingesta y las imágenes enviadas para similitud se remiten a Jina; las preguntas y los fragmentos recuperados se envían a Groq en la generación RAG. Revise las políticas de esos proveedores y use solo datos permitidos.
- Las rutas clínicas son para demostración académica con datos sintéticos. No exponga el servidor a Internet ni ingrese datos reales de pacientes: esta versión no implementa autenticación, autorización ni cifrado de datos clínicos.
- `/api/patients/{id}/medication-risks` solo identifica coincidencias literales en campos almacenados. Un resultado vacío **no significa** que el tratamiento sea seguro.
- La comparación temporal de diagnósticos informa secuencias observadas; no infiere causalidad ni recomienda conductas médicas.
