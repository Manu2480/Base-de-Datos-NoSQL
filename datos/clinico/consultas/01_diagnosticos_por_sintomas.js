// =====================================================================
// OBJETIVO 1 · Posibles diagnósticos para X cantidad de síntomas
// Uso:
//   docker compose exec mongodb mongosh vector_db /consultas/01_diagnosticos_por_sintomas.js
// Cambia la lista SINTOMAS_CONSULTA (nombres exactos de la colección sintomas).
// =====================================================================
db = db.getSiblingDB('vector_db');

const SINTOMAS_CONSULTA = ['Prurito', 'Vesículas', 'Costras melicéricas', 'Exudado'];

const sintomas = db.sintomas.find({ nombre: { $in: SINTOMAS_CONSULTA } }).toArray();
const ids = sintomas.map((s) => s._id);
const noEncontrados = SINTOMAS_CONSULTA.filter((n) => !sintomas.some((s) => s.nombre === n));
if (noEncontrados.length) print('⚠ Síntomas no encontrados: ' + noEncontrados.join(', '));

const resultado = db.diagnosticos_dermatologicos.aggregate([
  { $match: { sintomas_ids: { $in: ids } } },
  { $project: {
      _id: 0, diagnostico: '$nombre', categoria: 1,
      sintomas_coincidentes_ids: { $setIntersection: ['$sintomas_ids', ids] },
      total_sintomas_dx: { $size: '$sintomas_ids' },
      dx_id: '$_id',
  } },
  { $addFields: { coincidencias: { $size: '$sintomas_coincidentes_ids' } } },
  { $addFields: {
      // qué porcentaje de lo que trae el paciente explica el diagnóstico
      cobertura: { $round: [{ $divide: ['$coincidencias', ids.length] }, 2] },
      // qué porcentaje del cuadro típico del diagnóstico está presente
      especificidad: { $round: [{ $divide: ['$coincidencias', '$total_sintomas_dx'] }, 2] },
  } },
  { $addFields: { puntaje: { $round: [{ $add: [{ $multiply: ['$cobertura', 0.7] }, { $multiply: ['$especificidad', 0.3] }] }, 3] } } },
  // casos reales en las historias clínicas con ese diagnóstico (prevalencia en la base)
  { $lookup: { from: 'diagnosticos_asignados', localField: 'dx_id', foreignField: 'diagnostico_id', as: 'casos' } },
  { $lookup: { from: 'sintomas', localField: 'sintomas_coincidentes_ids', foreignField: '_id', as: 'sint' } },
  { $project: {
      diagnostico: 1, categoria: 1, coincidencias: 1, cobertura: 1, especificidad: 1, puntaje: 1,
      sintomas_coincidentes: '$sint.nombre',
      casos_en_historias: { $size: '$casos' },
  } },
  { $sort: { puntaje: -1, casos_en_historias: -1 } },
  { $limit: 10 },
]).toArray();

print(`\nSíntomas consultados: ${SINTOMAS_CONSULTA.join(', ')}\n`);
printjson(resultado);
