// =====================================================================
// OBJETIVO 4 · Correlación secuencial/consecuente entre diagnósticos
// Para cada paciente ordena sus diagnósticos en el tiempo y forma todos los
// pares (A antes que B). Luego cuenta en cuántos pacientes ocurre A -> B.
//   soporte    = nº de pacientes con A seguido de B
//   confianza  = soporte / nº de pacientes que tuvieron A   ("si tuvo A, qué tan seguido le vino B")
//   dias_promedio = tiempo medio entre A y B
// =====================================================================
db = db.getSiblingDB('vector_db');

const MIN_PACIENTES = 2;          // soporte mínimo
const DIAGNOSTICO_ORIGEN = null;  // ej. 'Dermatitis atópica' para ver solo lo que sigue a ese diagnóstico

let origenId = null;
if (DIAGNOSTICO_ORIGEN) origenId = db.diagnosticos_dermatologicos.findOne({ nombre: DIAGNOSTICO_ORIGEN })._id;

const resultado = db.diagnosticos_asignados.aggregate([
  { $group: { _id: '$paciente_id', dxs: { $push: { dx: '$diagnostico_id', fecha: '$fecha_diagnostico' } } } },
  { $project: { dxs: { $sortArray: { input: '$dxs', sortBy: { fecha: 1 } } } } },
  // todos los pares i < j
  { $project: { pares: { $reduce: {
      input: { $range: [0, { $size: '$dxs' }] },
      initialValue: [],
      in: { $concatArrays: ['$$value', { $map: {
        input: { $range: [{ $add: ['$$this', 1] }, { $size: '$dxs' }] },
        as: 'j',
        in: { desde: { $arrayElemAt: ['$dxs', '$$this'] }, hacia: { $arrayElemAt: ['$dxs', '$$j'] } },
      } }] },
  } } } },
  { $unwind: '$pares' },
  { $match: { $expr: { $and: [
      { $ne: ['$pares.desde.dx', '$pares.hacia.dx'] },
      { $lt: ['$pares.desde.fecha', '$pares.hacia.fecha'] },
  ] } } },
  ...(origenId ? [{ $match: { 'pares.desde.dx': origenId } }] : []),
  // un paciente cuenta una sola vez por par
  { $group: { _id: { paciente: '$_id', desde: '$pares.desde.dx', hacia: '$pares.hacia.dx' },
      dias: { $min: { $dateDiff: { startDate: '$pares.desde.fecha', endDate: '$pares.hacia.fecha', unit: 'day' } } } } },
  { $group: { _id: { desde: '$_id.desde', hacia: '$_id.hacia' }, soporte: { $sum: 1 }, dias_promedio: { $avg: '$dias' } } },
  { $match: { soporte: { $gte: MIN_PACIENTES } } },
  { $lookup: {
      from: 'diagnosticos_asignados',
      let: { a: '$_id.desde' },
      pipeline: [{ $match: { $expr: { $eq: ['$diagnostico_id', '$$a'] } } }, { $group: { _id: '$paciente_id' } }],
      as: 'pac_con_A',
  } },
  { $lookup: { from: 'diagnosticos_dermatologicos', localField: '_id.desde', foreignField: '_id', as: 'A' } },
  { $lookup: { from: 'diagnosticos_dermatologicos', localField: '_id.hacia', foreignField: '_id', as: 'B' } },
  { $project: {
      _id: 0,
      secuencia: { $concat: [{ $arrayElemAt: ['$A.nombre', 0] }, '  ->  ', { $arrayElemAt: ['$B.nombre', 0] }] },
      soporte: 1,
      confianza: { $round: [{ $divide: ['$soporte', { $size: '$pac_con_A' }] }, 2] },
      dias_promedio: { $round: ['$dias_promedio', 0] },
  } },
  { $sort: { soporte: -1, confianza: -1 } },
]).toArray();

print('\nSecuencias de diagnósticos encontradas en las historias clínicas:\n');
printjson(resultado);
