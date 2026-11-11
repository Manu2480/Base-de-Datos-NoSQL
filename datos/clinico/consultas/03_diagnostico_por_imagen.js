// =====================================================================
// OBJETIVO 3 · Reconocer diagnóstico/síntomas a partir de una imagen
// Compara el embedding de la imagen consultada contra todas las imágenes
// (atlas + pacientes) por similitud coseno, toma los K vecinos más cercanos
// y vota el diagnóstico. Devuelve también los síntomas típicos de cada candidato.
//
// En producción: el embedding de la foto nueva sale del modelo (jina-clip-v2) y se
// pega en VECTOR_CONSULTA. Para la demo se toma el vector de una imagen ya cargada.
//
// Nota: MongoDB 7 Community no trae $vectorSearch; este cálculo con $reduce funciona
// en cualquier MongoDB. Si migran a Atlas (o la imagen mongodb/mongodb-atlas-local)
// pueden crear un índice vectorial:
//   { fields: [{ type: 'vector', path: 'embedding_visual', numDimensions: 1024, similarity: 'cosine' }] }
// =====================================================================
db = db.getSiblingDB('vector_db');

const ARCHIVO_DEMO = 'imagenes/pacientes/DERM-0010/2026-06-23_psoriasis_en_placas_03.jpg';
const K = 7;

const imgConsulta = db.imagenes.findOne({ archivo: ARCHIVO_DEMO });
if (!imgConsulta) throw new Error('Imagen de demo no encontrada: ' + ARCHIVO_DEMO);
const VECTOR_CONSULTA = imgConsulta.embedding_visual;   // <- reemplazar por el vector del modelo
const normaConsulta = Math.sqrt(VECTOR_CONSULTA.reduce((s, x) => s + x * x, 0));

const vecinos = db.imagenes.aggregate([
  { $match: { _id: { $ne: imgConsulta._id } } },          // excluye la propia imagen de la demo
  { $project: {
      archivo: 1, diagnostico_id: 1, paciente_id: 1, descripcion_visual: 1,
      _calc: { $reduce: {
        input: { $zip: { inputs: ['$embedding_visual', VECTOR_CONSULTA] } },
        initialValue: { dot: 0, n2: 0 },
        in: {
          dot: { $add: ['$$value.dot', { $multiply: [{ $arrayElemAt: ['$$this', 0] }, { $arrayElemAt: ['$$this', 1] }] }] },
          n2: { $add: ['$$value.n2', { $multiply: [{ $arrayElemAt: ['$$this', 0] }, { $arrayElemAt: ['$$this', 0] }] }] },
        },
      } },
  } },
  { $addFields: { similitud: { $round: [{ $divide: ['$_calc.dot', { $multiply: [{ $sqrt: '$_calc.n2' }, normaConsulta] }] }, 4] } } },
  { $sort: { similitud: -1 } },
  { $limit: K },
  { $lookup: { from: 'diagnosticos_dermatologicos', localField: 'diagnostico_id', foreignField: '_id', as: 'dx' } },
  { $unwind: '$dx' },
  { $project: { _id: 0, archivo: 1, similitud: 1, diagnostico: '$dx.nombre', region: '$descripcion_visual.region_corporal', diagnostico_id: 1 } },
]).toArray();

// votación ponderada por similitud
const votos = {};
vecinos.forEach((v) => {
  const k = v.diagnostico;
  if (!votos[k]) votos[k] = { diagnostico: k, diagnostico_id: v.diagnostico_id, votos: 0, peso: 0, max_similitud: 0 };
  votos[k].votos += 1;
  votos[k].peso += v.similitud;
  votos[k].max_similitud = Math.max(votos[k].max_similitud, v.similitud);
});
const pesoTotal = Object.values(votos).reduce((s, x) => s + x.peso, 0);
const candidatos = Object.values(votos)
  .map((x) => {
    const dx = db.diagnosticos_dermatologicos.findOne({ _id: x.diagnostico_id });
    const sint = db.sintomas.find({ _id: { $in: dx.sintomas_ids } }).toArray().map((s) => s.nombre);
    return {
      diagnostico: x.diagnostico, categoria: dx.categoria, votos: x.votos,
      confianza: Math.round((x.peso / pesoTotal) * 100) / 100, max_similitud: x.max_similitud,
      sintomas_probables: sint, manifestaciones_visuales: dx.manifestaciones_visuales,
    };
  })
  .sort((a, b) => b.confianza - a.confianza);

print(`\nImagen consultada: ${ARCHIVO_DEMO}`);
print(`\n${K} imágenes más parecidas:`);
printjson(vecinos.map(({ diagnostico_id, ...r }) => r));
print('\nDiagnósticos candidatos:');
printjson(candidatos);
