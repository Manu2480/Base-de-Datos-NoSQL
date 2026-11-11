// =====================================================================
// OBJETIVO 5 · Pacientes que NO pueden tomar X medicamento
// Motivos:
//   a) alergia: la sustancia de la alergia coincide con una contraindicación
//      "Alergia a <sustancia>" del medicamento.
//   b) interacción: el paciente tiene un tratamiento VIGENTE con un medicamento
//      que interactúa con X (en cualquiera de los dos sentidos).
// Solo se consideran pacientes vivos.
// =====================================================================
db = db.getSiblingDB('vector_db');

const MEDICAMENTOS_CONSULTA = [
  'Trimetoprim-sulfametoxazol 800/160 mg',
  'Doxiciclina 100 mg',
  'Fluconazol 150 mg',
  'Ibuprofeno 400 mg',
  'Amoxicilina-ácido clavulánico 875/125 mg',
];

function consultar(nombreMed) {
  const med = db.medicamentos.findOne({ nombre: nombreMed });
  if (!med) throw new Error('Medicamento no encontrado: ' + nombreMed);

  // interacciones en ambos sentidos
  const inter = (med.interacciones || []).map((i) => ({ medicamento_id: i.medicamento_relacionado_id, descripcion: i.descripcion }));
  db.medicamentos.find({ 'interacciones.medicamento_relacionado_id': med._id }).toArray().forEach((m) => {
    if (!inter.some((i) => i.medicamento_id.equals(m._id))) {
      inter.push({ medicamento_id: m._id, descripcion: m.interacciones.find((i) => i.medicamento_relacionado_id.equals(med._id)).descripcion });
    }
  });
  const contraLower = med.contraindicaciones.map((c) => c.toLowerCase());

  return db.pacientes.aggregate([
    { $match: { fecha_defuncion: null } },
    { $lookup: { from: 'diagnosticos_asignados', localField: '_id', foreignField: 'paciente_id', as: 'dxa' } },
    { $project: {
        codigo_paciente: 1, nombre_completo: 1, alergias: 1,
        meds_vigentes: { $reduce: {
          input: '$dxa', initialValue: [],
          in: { $concatArrays: ['$$value', { $reduce: {
            input: { $filter: { input: '$$this.tratamientos_asignados', as: 't', cond: '$$t.vigente' } },
            initialValue: [],
            in: { $concatArrays: ['$$value', '$$this.medicamentos.medicamento_id'] },
          } }] },
        } },
    } },
    { $project: {
        codigo_paciente: 1, nombre_completo: 1,
        ya_lo_toma: { $in: [med._id, '$meds_vigentes'] },
        alergias_conflicto: { $filter: { input: '$alergias', as: 'a',
          cond: { $in: [{ $concat: ['alergia a ', { $toLower: '$$a.sustancia' }] }, contraLower] } } },
        interacciones_conflicto: { $filter: { input: { $literal: inter }, as: 'i',
          cond: { $in: ['$$i.medicamento_id', '$meds_vigentes'] } } },
    } },
    { $match: { $or: [{ 'alergias_conflicto.0': { $exists: true } }, { 'interacciones_conflicto.0': { $exists: true } }] } },
    { $lookup: { from: 'medicamentos', localField: 'interacciones_conflicto.medicamento_id', foreignField: '_id', as: 'meds_inter' } },
    { $project: {
        _id: 0, codigo_paciente: 1, nombre_completo: 1, ya_lo_toma: 1,
        por_alergia: { $map: { input: '$alergias_conflicto', as: 'a', in: { $concat: ['$$a.sustancia', ' (', { $ifNull: ['$$a.reaccion', ''] }, ')'] } } },
        por_interaccion: { $map: { input: '$interacciones_conflicto', as: 'i', in: { $concat: [
          { $let: { vars: { m: { $arrayElemAt: [{ $filter: { input: '$meds_inter', as: 'x', cond: { $eq: ['$$x._id', '$$i.medicamento_id'] } } }, 0] } }, in: '$$m.nombre' } },
          ' (en tratamiento vigente): ', '$$i.descripcion'] } } },
    } },
    { $sort: { codigo_paciente: 1 } },
  ]).toArray();
}

MEDICAMENTOS_CONSULTA.forEach((m) => {
  const r = consultar(m);
  print(`\n=== ${m}: ${r.length} paciente(s) no pueden tomarlo`);
  printjson(r);
});
