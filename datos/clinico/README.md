# Datos clínicos

Catálogo, pacientes sintéticos y consultas. Se cargan en `vector_db`, la misma base de la API. Los textos del RAG están en `datos/conocimiento/` y se enlazan a cada diagnóstico al arrancar la API. `datos_dermatologia.xlsx` repite estas tablas solo para revisarlas.

## Estructura
```
datos/clinico/
  init/
    01-esquema.js               colecciones, validación $jsonSchema e índices
    02-catalogo.js              43 síntomas, 26 diagnósticos, 32 medicamentos, 34 tratamientos
    03-pacientes.js             24 pacientes, historias, laboratorios y embeddings visuales sintéticos
  consultas/
    01_diagnosticos_por_sintomas.js     objetivo 1
    02_tratamientos_por_diagnostico.js  objetivo 2
    03_diagnostico_por_imagen.js        objetivo 3 (similitud coseno sobre embeddings)
    04_secuencias_diagnosticos.js       objetivo 4 (A -> B con soporte y confianza)
    05_pacientes_no_pueden_tomar.js     objetivo 5 (alergias + interacciones con tratamientos vigentes)
    06_contexto_ia_paciente.js          resumen de historia + candidatos + tratamientos aptos, listo para el prompt de la IA
  datos_dermatologia.xlsx       los mismos datos en tablas, para revisarlos
```

## Uso

Desde la raíz del repositorio, `docker compose up --build -d` carga estos scripts en el Mongo de la API cuando `vector_db` todavía no tiene el diagnóstico "Psoriasis en placas".

Para ejecutar una consulta, con Compose ya levantado:

```bash
docker compose exec mongodb mongosh vector_db /consultas/05_pacientes_no_pueden_tomar.js

# shell interactivo
docker compose exec mongodb mongosh vector_db
```

Cada consulta tiene sus parámetros arriba (síntomas, diagnóstico, medicamento, código de paciente).

En Atlas, desde la raíz y con `MONGODB_URI` en `.env`:

```bash
mongosh "$MONGODB_URI" datos/clinico/init/01-esquema.js datos/clinico/init/02-catalogo.js datos/clinico/init/03-pacientes.js
python -m backend.load_conocimiento
```

`01-esquema.js` borra y recrea las colecciones clínicas. Conserva `documentos_conocimiento`, `chunks`, `usuarios`, `consultas` y `evaluaciones`. Si se vuelve a correr, hay que ejecutar otra vez `python -m backend.load_conocimiento` para reenlazar los textos con los ObjectId nuevos.

## Datos de pacientes
- 24 pacientes (2 fallecidos), 88 episodios, 71 diagnósticos asignados (viejos y vigentes),
  92 exámenes de laboratorio (JSON y TXT: biopsias, cultivos, PCR, IgE, ALT, PASI…), 133 imágenes.
- Secuencias clínicas reales incluidas: dermatitis atópica → impétigo / eccema herpético,
  psoriasis con metotrexato o anti-TNF → herpes zóster / celulitis, nevus → melanoma,
  queratosis/fotodaño → carcinoma basocelular → espinocelular, tiña pedis → celulitis, escabiosis → impétigo,
  epidermólisis ampollosa → sobreinfecciones.
- Conflictos para el objetivo 5: alergias (penicilinas, sulfonamidas, AINEs, tetraciclinas, propilenglicol)
  e interacciones vigentes (metotrexato, isotretinoína, hidroxicloroquina).
- Convención: una alergia del paciente bloquea un medicamento cuando este tiene la contraindicación
  `"Alergia a <sustancia>"` con la misma sustancia.

## Embeddings
`embedding_visual` (double[1024]) es sintético y determinista: centroide por diagnóstico + ruido,
así la búsqueda por similitud ya agrupa por diagnóstico. Cuando tengan las fotos reales,
recalculen el campo con jina-clip-v2 y la consulta 03 funciona igual.
Los textos de `documentos_conocimiento` los carga la API desde `datos/conocimiento/`. `chunks` sigue vacío hasta la ingesta con embeddings. Las fotos reales, cuando existan, van en `datos/imagenes/`.
