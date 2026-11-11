// =====================================================================
// OBJETIVO 2 · Recomendar posibles tratamientos para X diagnóstico
// Devuelve cada tratamiento con sus medicamentos y pautas, y cuántas veces
// se ha usado para ese diagnóstico en las historias clínicas (y cuántas se suspendió).
// =====================================================================
db = db.getSiblingDB('vector_db');

const DIAGNOSTICO = 'Psoriasis en placas';

const dx = db.diagnosticos_dermatologicos.findOne({ nombre: DIAGNOSTICO });
if (!dx) throw new Error('Diagnóstico no encontrado: ' + DIAGNOSTICO);

const resultado = db.tratamientos.aggregate([
  { $match: { diagnosticos_ids: dx._id } },
  { $lookup: { from: 'medicamentos', localField: 'medicamentos.medicamento_id', foreignField: '_id', as: 'meds' } },
  // experiencia real: asignaciones de este tratamiento para este diagnóstico
  { $lookup: {
      from: 'diagnosticos_asignados',
      let: { tid: '$_id' },
      pipeline: [
        { $match: { diagnostico_id: dx._id } },
        { $unwind: '$tratamientos_asignados' },
        { $match: { $expr: { $eq: ['$tratamientos_asignados.tratamiento_id', '$$tid'] } } },
        { $project: { _id: 0, vigente: '$tratamientos_asignados.vigente', obs: '$tratamientos_asignados.observaciones' } },
      ],
      as: 'usos',
  } },
  { $project: {
      _id: 0, tratamiento: '$nombre', descripcion: 1, indicaciones: 1, precauciones: 1,
      medicamentos: { $map: {
        input: '$medicamentos', as: 'm',
        in: {
          nombre: { $let: { vars: { med: { $arrayElemAt: [{ $filter: { input: '$meds', as: 'x', cond: { $eq: ['$$x._id', '$$m.medicamento_id'] } } }, 0] } }, in: '$$med.nombre' } },
          pautas_generales: '$$m.pautas_generales',
        },
      } },
      veces_usado: { $size: '$usos' },
      en_curso_actualmente: { $size: { $filter: { input: '$usos', as: 'u', cond: '$$u.vigente' } } },
      veces_suspendido: { $size: { $filter: { input: '$usos', as: 'u', cond: { $regexMatch: { input: '$$u.obs', regex: 'suspend', options: 'i' } } } } },
  } },
  { $sort: { veces_usado: -1, tratamiento: 1 } },
]).toArray();

print(`\nTratamientos para: ${DIAGNOSTICO}\n`);
printjson(resultado);
