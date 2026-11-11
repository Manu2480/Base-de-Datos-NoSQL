// =====================================================================
// 06 · Contexto clínico para la IA
// Un paciente llega con síntomas nuevos. Este script arma lo que la IA necesita
// para responder basándose en su historia clínica:
//   1. Resumen de la historia (línea de tiempo, alergias, tratamientos vigentes, últimos exámenes).
//   2. Diagnósticos candidatos para los síntomas, marcando los que ya tuvo antes
//      y los que suelen aparecer después de sus diagnósticos previos (objetivo 4).
//   3. Tratamientos sugeridos para el candidato principal, con alertas de
//      alergias e interacciones para ESTE paciente (objetivo 5).
// El campo `contexto_texto` está listo para pegarse en el prompt del modelo.
// =====================================================================
db = db.getSiblingDB('vector_db');

const CODIGO_PACIENTE = 'DERM-0001';
const SINTOMAS_NUEVOS = ['Costras melicéricas', 'Prurito', 'Exudado'];

// ---------- catálogo en memoria ----------
const DX = {}, TR = {}, MED = {}, SIN = {};
db.diagnosticos_dermatologicos.find().toArray().forEach((d) => { DX[d._id.toString()] = d; });
db.tratamientos.find().toArray().forEach((t) => { TR[t._id.toString()] = t; });
db.medicamentos.find().toArray().forEach((m) => { MED[m._id.toString()] = m; });
db.sintomas.find().toArray().forEach((s) => { SIN[s._id.toString()] = s; });
const fmt = (d) => (d ? d.toISOString().slice(0, 10) : 'actual');

// ---------- 1. historia del paciente ----------
const pac = db.pacientes.findOne({ codigo_paciente: CODIGO_PACIENTE });
if (!pac) throw new Error('Paciente no encontrado');
const dxa = db.diagnosticos_asignados.find({ paciente_id: pac._id }).toArray()
  .sort((a, b) => a.fecha_diagnostico - b.fecha_diagnostico);
const labs = db.resultados_laboratorio.find({ paciente_id: pac._id }).toArray().sort((a, b) => b.fecha - a.fecha);
const historia = db.historias_medicas.findOne({ paciente_id: pac._id });

const medsVigentes = [];
dxa.forEach((d) => d.tratamientos_asignados.filter((t) => t.vigente).forEach((t) => t.medicamentos.forEach((m) => {
  medsVigentes.push({ id: m.medicamento_id.toString(), nombre: MED[m.medicamento_id.toString()].nombre, pauta: `${m.cantidad}, ${m.frecuencia}`, por: DX[d.diagnostico_id.toString()].nombre });
})));

const edad = Math.floor(((pac.fecha_defuncion || new Date()) - pac.fecha_nacimiento) / (365.25 * 864e5));
const lineas = [];
lineas.push(`PACIENTE ${pac.codigo_paciente} · ${pac.nombre_completo} · ${edad} años · ${pac.lugar_residencia.ciudad}, ${pac.lugar_residencia.pais}`);
lineas.push(`ALERGIAS: ${pac.alergias.length ? pac.alergias.map((a) => `${a.sustancia} (${a.reaccion})`).join('; ') : 'ninguna conocida'}`);
lineas.push(`MEDICAMENTOS VIGENTES: ${medsVigentes.length ? medsVigentes.map((m) => `${m.nombre} [${m.pauta}] por ${m.por}`).join('; ') : 'ninguno'}`);
lineas.push('HISTORIA CLÍNICA:');
const episodios = historia.episodios.slice().sort((a, b) => a.fecha - b.fecha);
episodios.forEach((ep, idx) => {
  const siguiente = episodios[idx + 1] ? episodios[idx + 1].fecha : new Date(8.64e15);
  lineas.push(`  - ${fmt(ep.fecha)}: ${ep.observaciones}`);
  ep.diagnosticos_asignados_ids.forEach((id) => {
    const d = dxa.find((x) => x._id.equals(id));
    const nuevo = d.fecha_diagnostico.getTime() === ep.fecha.getTime();
    lineas.push(`      Dx${nuevo ? '' : ' (seguimiento)'}: ${DX[d.diagnostico_id.toString()].nombre} (${d.vigente ? 'VIGENTE' : 'resuelto'}). ${nuevo ? d.observaciones : ''}`);
    // tratamientos iniciados en este episodio (entre esta fecha y el siguiente episodio)
    d.tratamientos_asignados.filter((t) => t.fecha_inicio >= ep.fecha && t.fecha_inicio < siguiente)
      .forEach((t) => {
        const meds = t.medicamentos.map((m) => MED[m.medicamento_id.toString()].nombre).join(', ');
        lineas.push(`      Tto: ${TR[t.tratamiento_id.toString()].nombre}${meds ? ' [' + meds + ']' : ''} ${fmt(t.fecha_inicio)} → ${fmt(t.fecha_fin)}${t.observaciones ? ' · ' + t.observaciones : ''}`);
      });
  });
  labs.filter((l) => ep.resultados_laboratorio_ids.some((id) => id.equals(l._id))).forEach((l) => {
    lineas.push(`      Lab: ${l.tipo_examen} · ${l.resultado.parametro} = ${l.resultado.valor}${l.resultado.observaciones ? ' (' + l.resultado.observaciones + ')' : ''}`);
  });
});

// ---------- 2. diagnósticos candidatos ----------
const idsSint = db.sintomas.find({ nombre: { $in: SINTOMAS_NUEVOS } }).toArray().map((s) => s._id.toString());
const previos = new Set(dxa.map((d) => d.diagnostico_id.toString()));

// qué diagnósticos suelen seguir a los que tuvo este paciente (en otros pacientes)
const siguientes = {};
db.diagnosticos_asignados.find({ diagnostico_id: { $in: dxa.map((d) => d.diagnostico_id) }, paciente_id: { $ne: pac._id } }).toArray()
  .forEach((a) => {
    db.diagnosticos_asignados.find({ paciente_id: a.paciente_id, fecha_diagnostico: { $gt: a.fecha_diagnostico } }).toArray()
      .forEach((b) => {
        const k = b.diagnostico_id.toString();
        if (!siguientes[k]) siguientes[k] = new Set();
        siguientes[k].add(`${a.paciente_id}`);
      });
  });

const candidatos = Object.values(DX).map((d) => {
  const sids = d.sintomas_ids.map((x) => x.toString());
  const coinc = sids.filter((s) => idsSint.includes(s));
  if (!coinc.length) return null;
  const cobertura = coinc.length / idsSint.length;
  const especificidad = coinc.length / sids.length;
  const k = d._id.toString();
  const antecedente = previos.has(k);
  const secuencia = siguientes[k] ? siguientes[k].size : 0;
  // puntaje base por síntomas + bonificación por historia clínica
  const puntaje = 0.7 * cobertura + 0.3 * especificidad + (antecedente ? 0.15 : 0) + Math.min(secuencia, 3) * 0.05;
  return {
    diagnostico: d.nombre, puntaje: Math.round(puntaje * 100) / 100,
    sintomas_coincidentes: coinc.map((s) => SIN[s].nombre),
    antecedente_en_paciente: antecedente,
    pacientes_con_misma_secuencia: secuencia,
    _id: d._id,
  };
}).filter(Boolean).sort((a, b) => b.puntaje - a.puntaje).slice(0, 5);

// ---------- 3. tratamientos para el candidato principal, con alertas ----------
const alergias = pac.alergias.map((a) => 'alergia a ' + a.sustancia.toLowerCase());
function alertasMedicamento(m) {
  const al = [];
  m.contraindicaciones.forEach((c) => { if (alergias.includes(c.toLowerCase())) al.push(`ALERGIA: ${c}`); });
  medsVigentes.forEach((v) => {
    const i1 = (m.interacciones || []).find((i) => i.medicamento_relacionado_id.toString() === v.id);
    const i2 = (MED[v.id].interacciones || []).find((i) => i.medicamento_relacionado_id.equals(m._id));
    const i = i1 || i2;
    if (i) al.push(`INTERACCIÓN con ${v.nombre} (vigente): ${i.descripcion}`);
  });
  return al;
}
const principal = candidatos[0];
const tratamientos = principal ? db.tratamientos.find({ diagnosticos_ids: principal._id }).toArray().map((t) => {
  const meds = t.medicamentos.map((x) => {
    const m = MED[x.medicamento_id.toString()];
    const al = alertasMedicamento(m);
    return { medicamento: m.nombre, apto: al.length === 0, alertas: al };
  });
  return { tratamiento: t.nombre, apto_para_paciente: meds.every((x) => x.apto), medicamentos: meds, precauciones: t.precauciones };
}).sort((a, b) => b.apto_para_paciente - a.apto_para_paciente) : [];

lineas.push(`SÍNTOMAS ACTUALES: ${SINTOMAS_NUEVOS.join(', ')}`);
lineas.push(`DIAGNÓSTICOS CANDIDATOS: ${candidatos.map((c) => `${c.diagnostico} (${c.puntaje}${c.antecedente_en_paciente ? ', ya lo tuvo' : ''})`).join('; ')}`);
lineas.push(`TRATAMIENTOS PARA ${principal ? principal.diagnostico.toUpperCase() : '-'}:`);
tratamientos.forEach((t) => lineas.push(`  - ${t.tratamiento}: ${t.apto_para_paciente ? 'APTO' : 'NO APTO'}${t.medicamentos.flatMap((m) => m.alertas).map((a) => ' · ' + a).join('')} (precauciones: ${t.precauciones.join('; ')})`));

printjson({
  paciente: pac.codigo_paciente,
  candidatos: candidatos.map(({ _id, ...c }) => c),
  tratamientos_sugeridos: tratamientos,
});
print('\n------------------ contexto_texto (para el prompt de la IA) ------------------\n');
print(lineas.join('\n'));
