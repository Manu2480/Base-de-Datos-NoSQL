// =====================================================================
// 01-esquema.js
// Crea las colecciones del diagrama con validación $jsonSchema e índices.
// Escribe en vector_db, la misma base que usa la API.
// Borra y recrea las colecciones clínicas. Conserva documentos_conocimiento,
// chunks, usuarios, consultas y evaluaciones.
// =====================================================================
db = db.getSiblingDB('vector_db');

const S = { bsonType: 'string' };
const OID = { bsonType: 'objectId' };
const DATE = { bsonType: 'date' };
const BOOL = { bsonType: 'bool' };
const OIDN = { bsonType: ['objectId', 'null'] };
const DATEN = { bsonType: ['date', 'null'] };
const INT = { bsonType: ['int', 'long'] };
const arr = (items) => ({ bsonType: 'array', items });
const obj = (required, properties) => {
  const schema = { bsonType: 'object', properties };
  if (required.length) schema.required = required;
  return schema;
};
const VECTOR_1024 = { bsonType: 'array', minItems: 1024, maxItems: 1024 };

const CONSERVAR = new Set([
  'documentos_conocimiento', 'chunks', 'usuarios', 'consultas', 'evaluaciones',
]);

function crear(nombre, schema) {
  const opciones = {
    validator: { $jsonSchema: schema },
    validationLevel: 'strict',
    validationAction: 'error',
  };
  if (CONSERVAR.has(nombre)) {
    if (!db.getCollectionNames().includes(nombre)) {
      db.createCollection(nombre, opciones);
      print(`✔ colección creada: ${nombre}`);
    } else {
      print(`✔ colección conservada: ${nombre}`);
    }
    return;
  }
  if (db.getCollectionNames().includes(nombre)) db.getCollection(nombre).drop();
  db.createCollection(nombre, opciones);
  print(`✔ colección creada: ${nombre}`);
}

// ---------------------------------------------------------------------
// Conocimiento clínico
// ---------------------------------------------------------------------
crear('sintomas', obj(['nombre'], {
  _id: OID, nombre: S, descripcion: S,
}));

crear('diagnosticos_dermatologicos', obj(['nombre', 'categoria'], {
  _id: OID, nombre: S, categoria: S, descripcion: S,
  manifestaciones_visuales: arr(S),
  sintomas_ids: arr(OID),
  tratamientos_ids: arr(OID),
}));

crear('tratamientos', obj(['nombre', 'diagnosticos_ids'], {
  _id: OID, nombre: S, descripcion: S,
  diagnosticos_ids: arr(OID),
  indicaciones: arr(S),
  precauciones: arr(S),
  medicamentos: arr(obj(['medicamento_id'], {
    medicamento_id: OID,
    pautas_generales: arr(obj(['grupo_poblacional', 'cantidad', 'frecuencia'], {
      grupo_poblacional: S, cantidad: S, frecuencia: S,
    })),
  })),
}));

crear('medicamentos', obj(['nombre', 'principio_activo'], {
  _id: OID, nombre: S, principio_activo: S,
  indicaciones: arr(S),
  contraindicaciones: arr(S),
  interacciones: arr(obj(['medicamento_relacionado_id', 'descripcion'], {
    medicamento_relacionado_id: OID, descripcion: S,
  })),
}));

// ---------------------------------------------------------------------
// Pacientes y casos clínicos
// ---------------------------------------------------------------------
crear('pacientes', obj(['codigo_paciente', 'nombre_completo', 'fecha_nacimiento'], {
  _id: OID, codigo_paciente: S, nombre_completo: S,
  fecha_nacimiento: DATE, fecha_defuncion: DATEN,
  lugar_residencia: obj(['pais', 'ciudad'], { pais: S, ciudad: S }),
  alergias: arr(obj(['sustancia'], { sustancia: S, reaccion: S })),
  diagnosticos_asignados_ids: arr(OID),
  historias_clinicas_ids: arr(OID),
}));

crear('diagnosticos_asignados', obj(['paciente_id', 'historia_medica_id', 'fecha_diagnostico', 'vigente'], {
  _id: OID, paciente_id: OID, historia_medica_id: OID, episodio_fecha: DATE,
  diagnostico_id: OIDN, fecha_diagnostico: DATE, vigente: BOOL, observaciones: S,
  tratamientos_asignados: arr(obj(['tratamiento_id', 'fecha_inicio', 'vigente'], {
    tratamiento_id: OID, fecha_inicio: DATE, fecha_fin: DATEN, vigente: BOOL, observaciones: S,
    medicamentos: arr(obj(['medicamento_id'], { medicamento_id: OID, cantidad: S, frecuencia: S })),
  })),
}));

crear('historias_medicas', obj(['paciente_id'], {
  _id: OID, paciente_id: OID,
  episodios: arr(obj(['fecha'], {
    fecha: DATE, observaciones: S,
    diagnosticos_asignados_ids: arr(OID),
    imagenes_ids: arr(OID),
    resultados_laboratorio_ids: arr(OID),
  })),
}));

crear('imagenes', obj(['diagnostico_id', 'archivo', 'embedding_visual', 'fecha_registro'], {
  _id: OID, paciente_id: OIDN, historia_medica_id: OIDN, episodio_fecha: DATEN,
  diagnostico_id: OID, archivo: S, embedding_visual: VECTOR_1024, fecha_registro: DATE,
  descripcion_visual: obj([], { colores: arr(S), texturas: arr(S), region_corporal: S }),
}));

crear('resultados_laboratorio', obj(['paciente_id', 'historia_medica_id', 'fecha', 'tipo_examen', 'formato', 'resultado'], {
  _id: OID, paciente_id: OID, historia_medica_id: OID, fecha: DATE, tipo_examen: S,
  formato: { enum: ['JSON', 'TXT'] },
  resultado: obj(['parametro', 'valor'], {
    parametro: S,
    valor: { bsonType: ['string', 'double', 'int', 'long', 'decimal'] },
    observaciones: S,
  }),
}));

// ---------------------------------------------------------------------
// Base de conocimiento RAG (se crean vacías)
// ---------------------------------------------------------------------
crear('documentos_conocimiento', obj(
  ['nombre_archivo', 'tipo_documento', 'idioma', 'contenido_texto', 'fecha'],
  {
    _id: OID, nombre_archivo: S, tipo_documento: S, idioma: S,
    contenido_texto: S, fecha: DATE, titulo: S, tema: S, categoria: S, fuente: S,
    diagnostico_id: OID,
  },
));

crear('chunks', obj(['doc_id', 'chunk_index', 'chunk_texto'], {
  _id: OID, doc_id: OID, chunk_index: INT,
  estrategia_chunking: { enum: ['fixed-size', 'sentence-aware', 'semantic'] },
  chunk_texto: S, embedding: VECTOR_1024, modelo: S, fecha_ingesta: DATE,
}));

// ---------------------------------------------------------------------
// Índices
// ---------------------------------------------------------------------
db.sintomas.createIndex({ nombre: 1 }, { unique: true });
db.diagnosticos_dermatologicos.createIndex({ nombre: 1 }, { unique: true });
db.diagnosticos_dermatologicos.createIndex({ categoria: 1 });
db.diagnosticos_dermatologicos.createIndex({ sintomas_ids: 1 });
db.tratamientos.createIndex({ nombre: 1 }, { unique: true });
db.tratamientos.createIndex({ diagnosticos_ids: 1 });
db.medicamentos.createIndex({ nombre: 1 }, { unique: true });
db.medicamentos.createIndex({ principio_activo: 1 });

db.pacientes.createIndex({ codigo_paciente: 1 }, { unique: true, sparse: true, name: 'idx_codigo_paciente' });
db.pacientes.createIndex({ 'alergias.sustancia': 1 });
db.diagnosticos_asignados.createIndex({ paciente_id: 1, fecha_diagnostico: 1 });
db.diagnosticos_asignados.createIndex({ diagnostico_id: 1 });
db.diagnosticos_asignados.createIndex({ 'tratamientos_asignados.vigente': 1, 'tratamientos_asignados.medicamentos.medicamento_id': 1 });
db.historias_medicas.createIndex({ paciente_id: 1 }, { name: 'idx_historia_paciente' });
db.imagenes.createIndex({ diagnostico_id: 1 }, { name: 'idx_imagen_diagnostico' });
db.imagenes.createIndex({ paciente_id: 1 });
db.resultados_laboratorio.createIndex({ paciente_id: 1, fecha: -1 }, { name: 'idx_laboratorio_paciente_fecha' });
db.resultados_laboratorio.createIndex({ tipo_examen: 1 });
db.chunks.createIndex(
  { doc_id: 1, estrategia_chunking: 1, chunk_index: 1 },
  { unique: true, name: 'idx_chunk_documento_estrategia_posicion' },
);

print('✔ Esquema e índices listos');
