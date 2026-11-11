// =====================================================================
// 03-pacientes.js
// Pacientes con historia clínica: episodios, diagnósticos viejos y vigentes,
// tratamientos (terminados y en curso), exámenes de laboratorio e imágenes.
// Además carga un "atlas" de imágenes de referencia (sin paciente) por diagnóstico.
//
// Los embeddings visuales (double[1024]) son SINTÉTICOS y deterministas:
// cada diagnóstico tiene un vector centroide y cada imagen es centroide + ruido.
// Así la búsqueda por similitud agrupa imágenes del mismo diagnóstico, igual que
// lo haría un modelo real (jina-clip-v2). Al conectar el modelo real basta con
// recalcular el campo embedding_visual a partir del archivo.
// =====================================================================
db = db.getSiblingDB('vector_db');

// ---------------------------------------------------------------------
// Catálogo cargado en 02-catalogo.js
// ---------------------------------------------------------------------
const DX = {}, TR = {}, MED = {};
db.diagnosticos_dermatologicos.find().forEach((d) => { DX[d.nombre] = d; });
db.tratamientos.find().forEach((t) => { TR[t.nombre] = t; });
db.medicamentos.find().forEach((m) => { MED[m.nombre] = m; });
const MED_BY_ID = {};
Object.values(MED).forEach((m) => { MED_BY_ID[m._id.toString()] = m; });

function req(m, k, tipo) { if (!m[k]) throw new Error(`${tipo} no encontrado: "${k}"`); return m[k]; }
const F = (s) => new Date(s + 'T00:00:00Z');

// ---------------------------------------------------------------------
// Generador pseudoaleatorio determinista + embeddings sintéticos
// ---------------------------------------------------------------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
function gauss(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
const DIM = 1024;
const rnd = mulberry32(20261105);
const centroides = {};
function centroide(dx) {
  if (!centroides[dx]) { const r = mulberry32(hash(dx)); centroides[dx] = Array.from({ length: DIM }, () => gauss(r)); }
  return centroides[dx];
}
function embedding(dx, ruido) {
  const c = centroide(dx);
  const v = c.map((x) => x + ruido * gauss(rnd));
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => { let y = Math.round((x / n) * 1e6) / 1e6; if (Number.isInteger(y)) y += 1e-6; return y; });
}

// Descripción visual por defecto para cada diagnóstico [colores, texturas]
const VISUAL = {
  'Dermatitis atópica': [['rojo', 'rosado'], ['descamativa', 'liquenificada', 'excoriada']],
  'Dermatitis de contacto alérgica': [['rojo'], ['vesiculosa', 'edematosa']],
  'Psoriasis en placas': [['rojo', 'blanco plateado'], ['escamosa gruesa', 'bien delimitada']],
  'Lupus eritematoso cutáneo': [['rojo violáceo'], ['descamativa', 'atrófica']],
  'Vitíligo': [['blanco tiza'], ['lisa', 'bordes netos']],
  'Impétigo': [['amarillo miel', 'rojo'], ['costrosa', 'erosiva']],
  'Celulitis': [['rojo intenso'], ['tensa', 'brillante', 'edematosa']],
  'Foliculitis bacteriana': [['rojo', 'amarillo'], ['pustulosa', 'perifolicular']],
  'Herpes simple': [['rojo', 'transparente'], ['vesiculosa agrupada']],
  'Herpes zóster': [['rojo', 'transparente'], ['vesiculosa', 'en banda dermatómica']],
  'Verruga vulgar': [['color piel', 'gris'], ['hiperqueratósica', 'rugosa']],
  'Tiña pedis': [['blanco', 'rojo'], ['macerada', 'descamativa', 'fisurada']],
  'Candidiasis cutánea': [['rojo brillante'], ['húmeda', 'pústulas satélite']],
  'Escabiosis': [['rojo'], ['papulosa', 'excoriada', 'surcos lineales']],
  'Acné vulgar': [['rojo', 'amarillo', 'negro'], ['comedoniana', 'papulopustulosa']],
  'Rosácea': [['rojo'], ['telangiectásica', 'papulosa']],
  'Alopecia areata': [['color piel'], ['lisa', 'placa sin pelo']],
  'Alopecia androgenética': [['color piel'], ['pelo fino', 'densidad reducida']],
  'Nevus melanocítico': [['marrón'], ['homogénea', 'bordes regulares']],
  'Queratosis seborreica': [['marrón', 'negro'], ['cérea', 'verrugosa', 'aspecto pegado']],
  'Lipoma': [['color piel'], ['abombada', 'lisa']],
  'Melanoma': [['marrón', 'negro', 'azul grisáceo', 'rojo'], ['asimétrica', 'bordes irregulares']],
  'Carcinoma basocelular': [['rosado perlado', 'rojo'], ['brillante', 'ulcerada', 'telangiectásica']],
  'Carcinoma espinocelular': [['rosado', 'amarillo'], ['queratósica', 'ulcerada', 'nodular']],
  'Ictiosis vulgar': [['gris', 'blanco'], ['escamas poligonales', 'seca']],
  'Epidermólisis ampollosa': [['rojo', 'rosado'], ['ampollosa', 'erosiva', 'cicatricial']],
};

// ---------------------------------------------------------------------
// Mini-DSL para escribir historias clínicas legibles
// ---------------------------------------------------------------------
// E(fecha, observaciones, {dx, seg, labs, imgs})       episodio
// Dx(diagnóstico, vigente, observaciones, [T...])      diagnóstico asignado en el episodio
// Seg(diagnóstico, [T...])                              seguimiento de un diagnóstico ya asignado (agrega tratamientos)
// T(tratamiento, inicio, fin|null, obs, meds?)          tratamiento asignado (inicio null = fecha del episodio)
//      meds opcional: [[medicamento, cantidad, frecuencia], ...]  o  ['solo', 'Medicamento A', ...]
// L(tipo_examen, parametro, valor, observaciones)       laboratorio formato JSON
// LT(tipo_examen, parametro, informe, observaciones)    laboratorio formato TXT (informe libre)
// I(diagnóstico, región corporal)                       imagen clínica
const E = (fecha, observaciones, x = {}) => ({ fecha, observaciones, dx: x.dx || [], seg: x.seg || [], labs: x.labs || [], imgs: x.imgs || [] });
const Dx = (nombre, vigente, observaciones, trats = []) => ({ nombre, vigente, observaciones, trats });
const Seg = (nombre, trats = []) => ({ nombre, trats });
const T = (nombre, inicio, fin, observaciones, meds) => ({ nombre, inicio, fin, observaciones, meds });
const L = (tipo, parametro, valor, observaciones) => ({ tipo, parametro, valor, observaciones, formato: 'JSON' });
const LT = (tipo, parametro, valor, observaciones) => ({ tipo, parametro, valor, observaciones, formato: 'TXT' });
const I = (dx, region) => ({ dx, region });

// ---------------------------------------------------------------------
// PACIENTES
// ---------------------------------------------------------------------
const PACIENTES = [
  // -------------------------------------------------------------------
  { codigo: 'DERM-0001', nombre: 'Laura Gómez Restrepo', nacimiento: '1994-03-12', residencia: ['Colombia', 'Manizales'],
    alergias: [['Penicilinas', 'Urticaria generalizada en 2009']],
    episodios: [
      E('2016-04-18', 'Consulta por prurito intenso en pliegues de codos y rodillas desde la infancia. Antecedente de asma y rinitis.', {
        dx: [Dx('Dermatitis atópica', true, 'Dermatitis atópica del adulto, SCORAD 42. Enfermedad crónica con brotes.', [
          T('Corticoterapia tópica de potencia media', null, '2016-05-20', 'Buena respuesta en 4 semanas'),
          T('Antihistamínico oral para prurito', null, '2016-06-01', 'Mejora del sueño'),
          T('Emolientes y queratolíticos', null, null, 'Mantenimiento diario indefinido'),
        ])],
        labs: [L('Inmunoglobulina E sérica', 'IgE total (UI/mL)', 620, 'Elevada. Referencia < 100 UI/mL'),
               L('Hemograma', 'Eosinófilos (%)', 7.2, 'Eosinofilia leve')],
        imgs: [I('Dermatitis atópica', 'fosa antecubital derecha'), I('Dermatitis atópica', 'hueco poplíteo')],
      }),
      E('2018-09-03', 'Lesiones con costras amarillentas sobre placas de eccema en mejilla y mentón. Rascado intenso las semanas previas.', {
        dx: [Dx('Impétigo', false, 'Impétigo secundario sobre dermatitis atópica (sobreinfección). Resuelto.', [
          T('Antibioterapia tópica', null, '2018-09-13', 'Se evita betalactámico oral por alergia a penicilinas'),
        ])],
        labs: [LT('Cultivo de secreción', 'Cultivo bacteriano', 'Staphylococcus aureus sensible a meticilina, sensible a mupirocina, clindamicina y trimetoprim-sulfametoxazol.', 'SAMS')],
        imgs: [I('Impétigo', 'mejilla izquierda')],
      }),
      E('2021-01-22', 'Erupción súbita de vesículas agrupadas y erosiones sobre zonas de eccema en cuello, con fiebre de 38.4 °C.', {
        dx: [Dx('Herpes simple', false, 'Eccema herpético (Kaposi-Juliusberg) sobre dermatitis atópica. Resuelto sin secuelas.', [
          T('Antiviral para herpes simple', null, '2021-02-01', 'Respuesta en 72 h'),
        ])],
        labs: [LT('PCR viral', 'PCR VHS-1/VHS-2', 'PCR positiva para VHS-1. Negativa para VHS-2.', 'Confirma eccema herpético')],
        imgs: [I('Herpes simple', 'cuello lateral')],
      }),
      E('2025-06-10', 'Brote severo de dermatitis atópica (SCORAD 68) refractario a corticoides tópicos. Afecta cara, cuello y tronco.', {
        seg: [Seg('Dermatitis atópica', [
          T('Terapia biológica anti-IL-4/IL-13', null, null, 'Inicio de dupilumab por enfermedad severa'),
          T('Inmunomodulador tópico', null, null, 'Para párpados y cuello'),
        ])],
        labs: [L('Inmunoglobulina E sérica', 'IgE total (UI/mL)', 1180, 'Muy elevada'),
               L('Hemograma', 'Eosinófilos (%)', 9.8, 'Eosinofilia')],
        imgs: [I('Dermatitis atópica', 'cuello y escote')],
      }),
      E('2026-01-15', 'Control a los 7 meses de dupilumab: SCORAD 18. Conjuntivitis leve.', {
        labs: [L('Hemograma', 'Eosinófilos (%)', 5.1, 'Mejoría')],
      }),
    ] },

  // -------------------------------------------------------------------
  { codigo: 'DERM-0002', nombre: 'Andrés Felipe Ríos Cardona', nacimiento: '1978-11-02', residencia: ['Colombia', 'Pereira'],
    alergias: [['Sulfonamidas', 'Exantema morbiliforme en 2012']],
    episodios: [
      E('2015-07-14', 'Placas descamativas en codos, rodillas y cuero cabelludo de 2 años de evolución. Padre con psoriasis.', {
        dx: [Dx('Psoriasis en placas', true, 'Psoriasis en placas, BSA 8%, PASI 9.', [
          T('Terapia tópica combinada para psoriasis', null, '2017-03-01', 'Respuesta parcial'),
        ])],
        labs: [LT('Biopsia de piel', 'Histopatología', 'Hiperplasia epidérmica psoriasiforme regular, paraqueratosis confluente, microabscesos de Munro y ausencia de capa granulosa.', 'Compatible con psoriasis')],
        imgs: [I('Psoriasis en placas', 'codo derecho'), I('Psoriasis en placas', 'rodilla izquierda')],
      }),
      E('2017-03-01', 'Empeoramiento: PASI 14, afectación ungueal. Se escala a metotrexato.', {
        seg: [Seg('Psoriasis en placas', [
          T('Terapia sistémica convencional para psoriasis', null, '2022-08-15', 'Suspendido por hepatotoxicidad'),
        ])],
        labs: [L('Perfil hepático', 'ALT (U/L)', 38, 'Normal. Basal antes de metotrexato'),
               L('Hemograma', 'Leucocitos (/µL)', 7200, 'Normal'),
               L('Índice de severidad', 'PASI', 14, 'Psoriasis moderada-severa')],
      }),
      E('2019-10-05', 'Dolor urente en hemitórax izquierdo y luego vesículas en banda T5. En tratamiento con metotrexato.', {
        dx: [Dx('Herpes zóster', false, 'Herpes zóster torácico en paciente inmunosuprimido por metotrexato. Resuelto sin neuralgia.', [
          T('Antiviral y analgesia para herpes zóster', null, '2019-10-20', 'No se usa ibuprofeno por interacción con metotrexato',
            ['solo', 'Valaciclovir 1 g', 'Pregabalina 75 mg']),
        ])],
        labs: [LT('PCR viral', 'PCR VVZ', 'PCR positiva para virus varicela-zóster en líquido vesicular.', 'Confirma zóster')],
        imgs: [I('Herpes zóster', 'hemitórax izquierdo')],
      }),
      E('2022-08-15', 'Transaminasas elevadas en control. Se suspende metotrexato y se inicia biológico tras descartar tuberculosis.', {
        seg: [Seg('Psoriasis en placas', [
          T('Terapia biológica anti-TNF', '2022-08-29', null, 'Adalimumab, buena tolerancia'),
        ])],
        labs: [L('Perfil hepático', 'ALT (U/L)', 112, 'Elevada (> 3x LSN): hepatotoxicidad por metotrexato'),
               LT('Tamizaje de tuberculosis', 'IGRA (QuantiFERON-TB Gold)', 'Resultado NEGATIVO. Radiografía de tórax sin alteraciones.', 'Apto para anti-TNF')],
      }),
      E('2026-02-11', 'Control: piel casi blanqueada, PASI 2.1. Sin infecciones recientes.', {
        labs: [L('Índice de severidad', 'PASI', 2.1, 'Respuesta PASI 90'),
               L('Perfil hepático', 'ALT (U/L)', 29, 'Normalizada')],
        imgs: [I('Psoriasis en placas', 'codo derecho')],
      }),
    ] },

  // -------------------------------------------------------------------
  { codigo: 'DERM-0003', nombre: 'María José Ospina Valencia', nacimiento: '2001-05-23', residencia: ['Colombia', 'Medellín'],
    alergias: [],
    episodios: [
      E('2017-02-20', 'Adolescente con comedones y pápulas en frente y mejillas.', {
        dx: [Dx('Acné vulgar', true, 'Acné comedoniano y papulopustuloso leve.', [
          T('Tratamiento tópico del acné', null, '2018-01-15', 'Respuesta parcial'),
        ])],
        imgs: [I('Acné vulgar', 'frente')],
      }),
      E('2018-01-15', 'Progresión a acné inflamatorio moderado en cara y espalda.', {
        seg: [Seg('Acné vulgar', [T('Antibioterapia oral para acné y rosácea', null, '2018-04-15', '12 semanas completas')])],
      }),
      E('2018-08-10', 'Pústulas perifoliculares en muslos tras depilación con cuchilla.', {
        dx: [Dx('Foliculitis bacteriana', false, 'Foliculitis superficial por rasurado. Resuelta.', [
          T('Antibioterapia tópica', null, '2018-08-20', ''),
        ])],
        imgs: [I('Foliculitis bacteriana', 'muslo derecho')],
      }),
      E('2026-03-04', 'Recaída con acné nódulo-quístico y cicatrices en mejillas y espalda. Inicia isotretinoína.', {
        seg: [Seg('Acné vulgar', [T('Retinoide oral para acné severo', null, null, '20 mg/día; peso 58 kg')])],
        labs: [L('Perfil lipídico', 'Triglicéridos (mg/dL)', 118, 'Normal, basal'),
               L('Perfil hepático', 'ALT (U/L)', 22, 'Normal, basal'),
               LT('Prueba de embarazo', 'β-hCG cualitativa', 'NEGATIVA', 'Requisito antes de isotretinoína')],
        imgs: [I('Acné vulgar', 'mejilla derecha'), I('Acné vulgar', 'espalda alta')],
      }),
      E('2026-09-10', 'Control mes 6 de isotretinoína: mejoría del 80%. Queilitis.', {
        labs: [L('Perfil lipídico', 'Triglicéridos (mg/dL)', 212, 'Elevación leve, vigilar'),
               LT('Prueba de embarazo', 'β-hCG cualitativa', 'NEGATIVA', 'Control mensual')],
      }),
    ] },

  // -------------------------------------------------------------------
  { codigo: 'DERM-0004', nombre: 'Jorge Enrique Salazar Mejía', nacimiento: '1952-08-30', defuncion: '2024-02-17', residencia: ['Colombia', 'Manizales'],
    alergias: [],
    episodios: [
      E('2012-05-08', 'Revisión de lunares. Fototipo II, caficultor con exposición solar crónica. Múltiples nevus en espalda.', {
        dx: [Dx('Nevus melanocítico', false, 'Nevus melanocíticos múltiples, uno atípico en espalda de 5 mm. Evolucionó a melanoma en 2019.', [
          T('Seguimiento dermatoscópico', null, '2019-11-20', 'Controles anuales'),
        ])],
        imgs: [I('Nevus melanocítico', 'espalda zona escapular derecha')],
      }),
      E('2016-03-15', 'Lesiones marrones de aspecto pegado en tronco.', {
        dx: [Dx('Queratosis seborreica', false, 'Queratosis seborreicas múltiples. Tratadas.', [
          T('Crioterapia con nitrógeno líquido', null, '2016-03-15', 'Sesión única'),
        ])],
        imgs: [I('Queratosis seborreica', 'tronco anterior')],
      }),
      E('2019-11-20', 'El nevus vigilado en espalda creció a 9 mm, con bordes irregulares, varios colores y sangrado ocasional.', {
        dx: [Dx('Melanoma', true, 'Melanoma de extensión superficial sobre nevus previo. Estadio IIA.', [
          T('Escisión quirúrgica con márgenes', '2019-12-05', '2019-12-05', 'Ampliación con margen de 2 cm'),
        ])],
        labs: [LT('Biopsia de piel', 'Histopatología', 'Melanoma maligno de extensión superficial, Breslow 2.4 mm, Clark IV, sin ulceración, 3 mitosis/mm². Márgenes libres. Ganglio centinela negativo.', 'pT3a N0'),
               L('Química sanguínea', 'LDH (U/L)', 210, 'Normal')],
        imgs: [I('Melanoma', 'espalda zona escapular derecha')],
      }),
      E('2022-06-30', 'Pérdida de peso y adenopatía axilar derecha. Remitido a oncología.', {
        labs: [L('Química sanguínea', 'LDH (U/L)', 486, 'Elevada: sugiere enfermedad metastásica'),
               LT('Tomografía', 'TAC tórax-abdomen', 'Adenopatías axilares derechas y dos nódulos pulmonares compatibles con metástasis.', 'Melanoma estadio IV')],
      }),
    ] },

  // -------------------------------------------------------------------
  { codigo: 'DERM-0005', nombre: 'Carolina Arango Duque', nacimiento: '1988-01-09', residencia: ['Colombia', 'Bogotá'],
    alergias: [['AINEs', 'Angioedema con ibuprofeno en 2014']],
    episodios: [
      E('2020-04-02', 'Eritema en alas de mariposa que empeora con el sol, artralgias y fatiga.', {
        dx: [Dx('Lupus eritematoso cutáneo', true, 'Lupus eritematoso cutáneo agudo con anticuerpos positivos. Seguimiento conjunto con reumatología.', [
          T('Terapia antipalúdica', null, null, 'Hidroxicloroquina continua'),
          T('Corticoterapia tópica de potencia media', null, '2020-06-01', 'Ciclo corto en brote'),
        ])],
        labs: [LT('Inmunología', 'Anticuerpos antinucleares (ANA)', 'ANA positivo 1:640, patrón moteado. Anti-Ro/SSA positivo. Anti-DNA negativo.', 'Perfil de lupus cutáneo subagudo/agudo'),
               L('Complemento', 'C3 (mg/dL)', 78, 'Levemente bajo. Ref 90-180')],
        imgs: [I('Lupus eritematoso cutáneo', 'cara (región malar)')],
      }),
      E('2022-01-18', 'Placa redonda sin pelo en región occipital, sin cicatriz.', {
        dx: [Dx('Alopecia areata', false, 'Alopecia areata en placa única, repoblada a los 4 meses.', [
          T('Tratamiento de la alopecia areata', null, '2022-05-20', 'Repoblación completa', ['solo', 'Clobetasol propionato 0.05% crema']),
        ])],
        imgs: [I('Alopecia areata', 'cuero cabelludo occipital')],
      }),
      E('2025-11-05', 'Placas rojas brillantes húmedas en pliegue submamario con pústulas satélite.', {
        dx: [Dx('Candidiasis cutánea', false, 'Candidiasis intertriginosa. Se evitó fluconazol por interacción con hidroxicloroquina (QT). Resuelta.', [
          T('Antifúngico tópico', null, '2025-12-05', ''),
        ])],
        labs: [LT('Examen directo', 'KOH', 'Se observan pseudohifas y levaduras.', 'Positivo para Candida')],
        imgs: [I('Candidiasis cutánea', 'pliegue submamario')],
      }),
      E('2026-08-20', 'Control anual de hidroxicloroquina. Lupus cutáneo inactivo.', {
        labs: [LT('Oftalmología', 'Tomografía de coherencia óptica (OCT)', 'Sin signos de maculopatía por antipalúdicos.', 'Continuar'),
               L('Electrocardiograma', 'QTc (ms)', 432, 'Normal')],
      }),
    ] },

  // -------------------------------------------------------------------
  { codigo: 'DERM-0006', nombre: 'Santiago Herrera Zuluaga', nacimiento: '2015-06-17', residencia: ['Colombia', 'Manizales'],
    alergias: [],
    episodios: [
      E('2022-03-11', 'Niño de 6 años con prurito que empeora de noche; hermano y madre con síntomas similares.', {
        dx: [Dx('Escabiosis', false, 'Escabiosis familiar. Se trató a todos los convivientes. Curada.', [
          T('Escabicida tópico', null, '2022-03-18', 'Dos aplicaciones'),
          T('Antihistamínico oral para prurito', null, '2022-03-25', ''),
        ])],
        labs: [LT('Examen directo', 'Raspado de piel', 'Se identifican ácaros Sarcoptes scabiei y huevos.', 'Positivo')],
        imgs: [I('Escabiosis', 'espacios interdigitales de la mano')],
      }),
      E('2022-03-30', 'Costras melicéricas en zonas excoriadas por rascado de la escabiosis.', {
        dx: [Dx('Impétigo', false, 'Impétigo secundario a escabiosis. Resuelto.', [
          T('Antibioterapia tópica', null, '2022-04-08', ''),
          T('Antibioterapia oral antiestafilocócica', null, '2022-04-08', 'Por extensión de lesiones'),
        ])],
        labs: [LT('Cultivo de secreción', 'Cultivo bacteriano', 'Staphylococcus aureus sensible a meticilina.', 'SAMS')],
        imgs: [I('Impétigo', 'antebrazo izquierdo')],
      }),
      E('2024-10-02', 'Placas eccematosas en flexuras, piel muy seca. Antecedente de rinitis alérgica.', {
        dx: [Dx('Dermatitis atópica', true, 'Dermatitis atópica infantil leve-moderada.', [
          T('Corticoterapia tópica de baja potencia', null, '2024-10-23', ''),
          T('Emolientes y queratolíticos', null, null, 'Mantenimiento'),
        ])],
        labs: [L('Inmunoglobulina E sérica', 'IgE total (UI/mL)', 350, 'Elevada')],
        imgs: [I('Dermatitis atópica', 'fosa antecubital izquierda')],
      }),
      E('2026-07-14', 'Lesión rugosa en dedo índice derecho de 3 meses.', {
        dx: [Dx('Verruga vulgar', true, 'Verruga vulgar periungueal.', [
          T('Queratolítico para verrugas', null, null, 'En curso'),
        ])],
        imgs: [I('Verruga vulgar', 'dedo índice derecho')],
      }),
    ] },

  // -------------------------------------------------------------------
  { codigo: 'DERM-0007', nombre: 'Luz Marina Cifuentes Pérez', nacimiento: '1960-12-01', residencia: ['Colombia', 'Cali'],
    alergias: [['Penicilinas', 'Anafilaxia con amoxicilina en 1998']],
    episodios: [
      E('2018-06-05', 'Prurito y maceración entre los dedos 4 y 5 de ambos pies. Diabética tipo 2.', {
        dx: [Dx('Tiña pedis', false, 'Tiña pedis interdigital bilateral. Curada.', [
          T('Antifúngico tópico', null, '2018-07-05', ''),
          T('Antifúngico oral para dermatofitos', null, '2018-07-05', '4 semanas'),
        ])],
        labs: [LT('Examen directo', 'KOH', 'Hifas septadas abundantes.', 'Positivo'),
               LT('Cultivo micológico', 'Cultivo', 'Trichophyton rubrum.', 'Dermatofito'),
               L('Perfil hepático', 'ALT (U/L)', 25, 'Normal antes de terbinafina'),
               L('Control metabólico', 'HbA1c (%)', 7.9, 'Diabetes no controlada')],
        imgs: [I('Tiña pedis', 'espacio interdigital pie izquierdo')],
      }),
      E('2018-09-21', 'Pierna izquierda roja, caliente, edematosa y dolorosa con fiebre. Fisura interdigital como puerta de entrada.', {
        dx: [Dx('Celulitis', false, 'Celulitis de pierna con puerta de entrada por tiña pedis recidivante. Por anafilaxia a penicilinas no se usan betalactámicos. Resuelta.', [
          T('Antibioterapia oral para SARM', null, '2018-10-01', '10 días'),
        ])],
        labs: [L('Reactantes de fase aguda', 'Proteína C reactiva (mg/L)', 86, 'Elevada'),
               L('Hemograma', 'Leucocitos (/µL)', 14200, 'Leucocitosis con neutrofilia')],
        imgs: [I('Celulitis', 'pierna izquierda')],
      }),
      E('2023-02-14', 'Recidiva de descamación y prurito interdigital.', {
        dx: [Dx('Tiña pedis', false, 'Recidiva de tiña pedis. Curada con tópico.', [
          T('Antifúngico tópico', null, '2023-03-14', ''),
        ])],
        imgs: [I('Tiña pedis', 'espacio interdigital pie derecho')],
      }),
      E('2026-05-19', 'Placa rosada brillante de 1.2 cm en hombro con costra central.', {
        dx: [Dx('Carcinoma basocelular', true, 'Carcinoma basocelular superficial. Paciente prefiere tratamiento no quirúrgico.', [
          T('Inmunoterapia tópica oncológica', null, null, 'Imiquimod 6 semanas, en curso'),
        ])],
        labs: [LT('Biopsia de piel', 'Histopatología', 'Carcinoma basocelular de patrón superficial multifocal.', 'Subtipo de bajo riesgo')],
        imgs: [I('Carcinoma basocelular', 'hombro derecho')],
      }),
    ] },

  // -------------------------------------------------------------------
  { codigo: 'DERM-0008', nombre: 'Héctor Mauricio Londoño Gil', nacimiento: '1949-04-25', residencia: ['Colombia', 'Manizales'],
    alergias: [],
    episodios: [
      E('2014-08-12', 'Agricultor jubilado. Múltiples lesiones marrones verrugosas en espalda.', {
        dx: [Dx('Queratosis seborreica', false, 'Queratosis seborreicas múltiples. Tratadas.', [
          T('Crioterapia con nitrógeno líquido', null, '2014-08-12', ''),
        ])],
        imgs: [I('Queratosis seborreica', 'espalda')],
      }),
      E('2017-10-03', 'Pápula perlada con telangiectasias en ala nasal izquierda que sangra al secarse.', {
        dx: [Dx('Carcinoma basocelular', false, 'Carcinoma basocelular nodular. Extirpado con márgenes libres.', [
          T('Escisión quirúrgica con márgenes', '2017-10-20', '2017-10-20', 'Márgenes de 4 mm'),
        ])],
        labs: [LT('Biopsia de piel', 'Histopatología', 'Carcinoma basocelular nodular. Márgenes laterales y profundo libres.', '')],
        imgs: [I('Carcinoma basocelular', 'ala nasal izquierda')],
      }),
      E('2023-05-16', 'Nódulo queratósico de crecimiento rápido en dorso de mano derecha.', {
        dx: [Dx('Carcinoma espinocelular', false, 'Carcinoma espinocelular bien diferenciado sobre piel con fotodaño. Extirpado.', [
          T('Escisión quirúrgica con márgenes', '2023-06-02', '2023-06-02', 'Márgenes de 6 mm'),
        ])],
        labs: [LT('Biopsia de piel', 'Histopatología', 'Carcinoma escamocelular bien diferenciado, invasión hasta dermis reticular, sin invasión perineural. Márgenes libres.', 'Bajo riesgo')],
        imgs: [I('Carcinoma espinocelular', 'dorso de mano derecha')],
      }),
      E('2026-04-08', 'Dolor intenso y vesículas en frente y párpado derecho (rama oftálmica). Valorado por oftalmología.', {
        dx: [Dx('Herpes zóster', true, 'Herpes zóster oftálmico. Las lesiones resolvieron, persiste neuralgia postherpética.', [
          T('Antiviral y analgesia para herpes zóster', null, '2026-04-15', 'Valaciclovir con dosis ajustada a función renal', ['solo', 'Valaciclovir 1 g']),
          T('Antiviral y analgesia para herpes zóster', null, null, 'Pregabalina continua por neuralgia postherpética', ['solo', 'Pregabalina 75 mg']),
        ])],
        labs: [L('Función renal', 'Creatinina (mg/dL)', 1.4, 'Elevada leve; TFG 48 mL/min'),
               LT('PCR viral', 'PCR VVZ', 'Positiva para virus varicela-zóster.', '')],
        imgs: [I('Herpes zóster', 'frente y párpado derecho')],
      }),
    ] },

  // -------------------------------------------------------------------
  { codigo: 'DERM-0009', nombre: 'Valentina Castaño Ruiz', nacimiento: '1999-09-14', residencia: ['Colombia', 'Armenia'],
    alergias: [['Níquel', 'Dermatitis de contacto con hebillas y aretes']],
    episodios: [
      E('2019-01-30', 'Manchas blancas en dorso de manos, codos y alrededor de los ojos, progresivas en 1 año.', {
        dx: [Dx('Vitíligo', true, 'Vitíligo no segmentario, BSA 6%. Asociado a tiroiditis autoinmune.', [
          T('Inmunomodulador tópico', null, null, 'Cara y párpados'),
          T('Fototerapia UVB de banda estrecha', '2019-03-01', '2020-03-01', '70 sesiones; repigmentación 50%'),
        ])],
        labs: [L('Función tiroidea', 'TSH (µUI/mL)', 6.8, 'Elevada'),
               LT('Inmunología', 'Anticuerpos anti-TPO', 'Positivos: 412 UI/mL.', 'Tiroiditis de Hashimoto')],
        imgs: [I('Vitíligo', 'dorso de manos'), I('Vitíligo', 'región periocular')],
      }),
      E('2021-07-07', 'Dos placas sin pelo en región parietal.', {
        dx: [Dx('Alopecia areata', true, 'Alopecia areata multifocal, cursa con recaídas.', [
          T('Tratamiento de la alopecia areata', null, '2021-10-01', 'Clobetasol en ciclo', ['solo', 'Clobetasol propionato 0.05% crema']),
          T('Tratamiento de la alopecia areata', null, null, 'Minoxidil continuo', ['solo', 'Minoxidil 5% solución']),
        ])],
        imgs: [I('Alopecia areata', 'cuero cabelludo parietal')],
      }),
      E('2023-03-22', 'Placa eccematosa vesiculosa en abdomen bajo la hebilla del pantalón.', {
        dx: [Dx('Dermatitis de contacto alérgica', false, 'Dermatitis de contacto alérgica a níquel. Resuelta evitando el alérgeno.', [
          T('Corticoterapia tópica de potencia media', null, '2023-04-05', ''),
        ])],
        labs: [LT('Pruebas epicutáneas', 'Patch test (batería estándar)', 'Sulfato de níquel: positivo +++ a las 96 h. Resto negativo.', 'Alergia de contacto a níquel')],
        imgs: [I('Dermatitis de contacto alérgica', 'abdomen periumbilical')],
      }),
    ] },

  // -------------------------------------------------------------------
  { codigo: 'DERM-0010', nombre: 'Juan Pablo Montoya Ramírez', nacimiento: '1985-02-28', residencia: ['Colombia', 'Bogotá'],
    alergias: [],
    episodios: [
      E('2021-05-19', 'Placas eritematoescamosas en tronco y extremidades, 15% de superficie corporal.', {
        dx: [Dx('Psoriasis en placas', true, 'Psoriasis en placas moderada.', [
          T('Terapia tópica combinada para psoriasis', null, '2022-02-01', 'Insuficiente'),
        ])],
        labs: [L('Índice de severidad', 'PASI', 12.5, 'Moderada')],
        imgs: [I('Psoriasis en placas', 'espalda baja')],
      }),
      E('2022-02-01', 'Sin respuesta adecuada a tópicos. Inicia metotrexato semanal.', {
        seg: [Seg('Psoriasis en placas', [T('Terapia sistémica convencional para psoriasis', null, null, 'Metotrexato 15 mg/semana + ácido fólico')])],
        labs: [L('Perfil hepático', 'ALT (U/L)', 30, 'Basal normal'),
               L('Hemograma', 'Plaquetas (/µL)', 245000, 'Normal'),
               L('Función renal', 'Creatinina (mg/dL)', 0.9, 'Normal')],
      }),
      E('2024-09-09', 'Pústulas en barba tras afeitado.', {
        dx: [Dx('Foliculitis bacteriana', false, 'Foliculitis de la barba. Se evitó trimetoprim-sulfametoxazol por metotrexato. Resuelta.', [
          T('Antibioterapia tópica', null, '2024-09-19', ''),
        ])],
        imgs: [I('Foliculitis bacteriana', 'barba')],
      }),
      E('2026-06-23', 'Control de psoriasis en metotrexato: PASI 4.0.', {
        labs: [L('Índice de severidad', 'PASI', 4.0, 'Buena respuesta'),
               L('Perfil hepático', 'ALT (U/L)', 41, 'Normal-alto, vigilar'),
               L('Hemograma', 'Leucocitos (/µL)', 5100, 'Normal')],
        imgs: [I('Psoriasis en placas', 'espalda baja')],
      }),
    ] },

  // -------------------------------------------------------------------
  { codigo: 'DERM-0011', nombre: 'Daniela Rojas Bermúdez', nacimiento: '1992-07-19', residencia: ['Colombia', 'Pereira'],
    alergias: [['Tetraciclinas', 'Reacción fototóxica ampollosa con doxiciclina en 2008'], ['Parafenilendiamina', 'Dermatitis con tintes de cabello']],
    episodios: [
      E('2008-03-03', 'Acné papulopustuloso en cara.', {
        dx: [Dx('Acné vulgar', false, 'Acné vulgar moderado. Remitió en la adultez.', [
          T('Tratamiento tópico del acné', null, '2009-06-01', ''),
          T('Antibioterapia oral para acné y rosácea', '2008-05-02', '2008-05-20', 'SUSPENDIDO: reacción fototóxica ampollosa. Se registra alergia a tetraciclinas.'),
        ])],
        imgs: [I('Acné vulgar', 'mejillas')],
      }),
      E('2020-11-12', 'Enrojecimiento facial persistente con ardor, telangiectasias y pápulas sin comedones.', {
        dx: [Dx('Rosácea', true, 'Rosácea papulopustulosa. No candidata a doxiciclina por alergia a tetraciclinas.', [
          T('Tratamiento tópico de la rosácea', null, null, 'Metronidazol continuo'),
        ])],
        imgs: [I('Rosácea', 'mejillas y nariz')],
      }),
      E('2024-04-29', 'Eccema agudo en cuero cabelludo, frente y orejas 48 h después de teñirse el cabello.', {
        dx: [Dx('Dermatitis de contacto alérgica', false, 'Dermatitis de contacto alérgica a parafenilendiamina. Resuelta.', [
          T('Corticoterapia tópica de baja potencia', null, '2024-05-10', 'Por estar en cara'),
          T('Antihistamínico oral para prurito', null, '2024-05-10', ''),
        ])],
        labs: [LT('Pruebas epicutáneas', 'Patch test (batería estándar)', 'Parafenilendiamina: positivo +++. Resto negativo.', '')],
        imgs: [I('Dermatitis de contacto alérgica', 'frente e implantación del cabello')],
      }),
    ] },

  // -------------------------------------------------------------------
  { codigo: 'DERM-0012', nombre: 'Sebastián Torres Aguirre', nacimiento: '2010-11-08', residencia: ['Colombia', 'Manizales'],
    alergias: [],
    episodios: [
      E('2011-02-14', 'Lactante con ampollas desde el nacimiento en manos, pies y zonas de roce del pañal.', {
        dx: [Dx('Epidermólisis ampollosa', true, 'Epidermólisis ampollosa distrófica recesiva. Enfermedad genética de por vida.', [
          T('Cuidado de heridas en epidermólisis ampollosa', null, null, 'Curaciones diarias por enfermería domiciliaria'),
          T('Emolientes y queratolíticos', null, null, 'Solo en piel intacta'),
        ])],
        labs: [LT('Estudio genético', 'Secuenciación del gen COL7A1', 'Mutaciones bialélicas en COL7A1 (c.6527dupC / c.7786delG).', 'EB distrófica recesiva'),
               LT('Biopsia de piel', 'Inmunofluorescencia (mapeo antigénico)', 'Despegamiento sublámina densa; colágeno VII marcadamente reducido.', '')],
        imgs: [I('Epidermólisis ampollosa', 'manos')],
      }),
      E('2019-06-03', 'Erosiones crónicas en rodillas con costras amarillentas y mal olor.', {
        dx: [Dx('Impétigo', false, 'Sobreinfección estafilocócica de erosiones por EB. Resuelta.', [
          T('Antibioterapia oral antiestafilocócica', null, '2019-06-13', ''),
        ])],
        labs: [LT('Cultivo de secreción', 'Cultivo bacteriano', 'Staphylococcus aureus sensible a meticilina.', ''),
               L('Hemograma', 'Hemoglobina (g/dL)', 9.8, 'Anemia crónica de la EB')],
        imgs: [I('Impétigo', 'rodilla derecha')],
      }),
      E('2025-08-21', 'Placas rojas húmedas en ingles con lesiones satélite.', {
        dx: [Dx('Candidiasis cutánea', false, 'Candidiasis inguinal. Resuelta.', [
          T('Antifúngico oral para Candida', null, '2025-09-11', 'Se prefirió vía oral por dolor con tópicos'),
        ])],
        labs: [LT('Examen directo', 'KOH', 'Pseudohifas y levaduras.', 'Positivo'),
               L('Hemograma', 'Hemoglobina (g/dL)', 10.1, 'Anemia crónica estable')],
        imgs: [I('Candidiasis cutánea', 'región inguinal')],
      }),
      E('2026-10-01', 'Control: erosión de 3 meses en pie derecho que no cicatriza. Se toma biopsia para descartar carcinoma espinocelular.', {
        labs: [LT('Biopsia de piel', 'Histopatología', 'Tejido de granulación e hiperplasia pseudoepiteliomatosa. Sin evidencia de malignidad.', 'Repetir si persiste')],
        imgs: [I('Epidermólisis ampollosa', 'pie derecho')],
      }),
    ] },

  // -------------------------------------------------------------------
  { codigo: 'DERM-0013', nombre: 'Ana Lucía Patiño Jaramillo', nacimiento: '1970-03-05', residencia: ['Colombia', 'Medellín'],
    alergias: [['Sulfonamidas', 'Síndrome de Stevens-Johnson en 1995']],
    episodios: [
      E('2005-06-20', 'Piel seca con escamas finas en piernas desde la infancia; su madre tiene lo mismo.', {
        dx: [Dx('Ictiosis vulgar', true, 'Ictiosis vulgar hereditaria.', [
          T('Emolientes y queratolíticos', null, null, 'Uso diario permanente'),
        ])],
        imgs: [I('Ictiosis vulgar', 'pierna izquierda')],
      }),
      E('2012-09-15', 'Eccema pruriginoso en flexuras y manos.', {
        dx: [Dx('Dermatitis atópica', true, 'Dermatitis atópica del adulto asociada a ictiosis vulgar (mutación de filagrina).', [
          T('Corticoterapia tópica de potencia media', null, '2012-10-15', ''),
          T('Antihistamínico oral para prurito', null, null, 'Uso nocturno continuo'),
        ])],
        labs: [LT('Estudio genético', 'Gen FLG', 'Mutación heterocigota R501X en filagrina.', 'Explica ictiosis y atopia'),
               L('Inmunoglobulina E sérica', 'IgE total (UI/mL)', 290, 'Elevada')],
        imgs: [I('Dermatitis atópica', 'dorso de manos')],
      }),
      E('2020-02-10', 'Descamación y fisuras en plantas y entre los dedos.', {
        dx: [Dx('Tiña pedis', false, 'Tiña pedis en mocasín. Curada.', [
          T('Antifúngico oral para dermatofitos', null, '2020-03-23', '6 semanas'),
        ])],
        labs: [LT('Examen directo', 'KOH', 'Hifas septadas.', 'Positivo'),
               L('Perfil hepático', 'ALT (U/L)', 19, 'Normal')],
        imgs: [I('Tiña pedis', 'planta del pie derecho')],
      }),
    ] },

  // -------------------------------------------------------------------
  { codigo: 'DERM-0014', nombre: 'Camilo Andrés Vargas Osorio', nacimiento: '1996-10-30', residencia: ['Colombia', 'Manizales'],
    alergias: [],
    episodios: [
      E('2013-05-06', 'Acné inflamatorio en cara y espalda.', {
        dx: [Dx('Acné vulgar', false, 'Acné vulgar moderado. Resuelto.', [
          T('Tratamiento tópico del acné', null, '2014-02-01', ''),
          T('Antibioterapia oral para acné y rosácea', null, '2013-08-06', ''),
        ])],
        imgs: [I('Acné vulgar', 'espalda')],
      }),
      E('2016-11-21', 'Vesículas agrupadas dolorosas en labio superior, tercer episodio en el año.', {
        dx: [Dx('Herpes simple', true, 'Herpes labial recurrente (≥ 6 episodios/año desde 2023).', [
          T('Antiviral para herpes simple', null, '2016-11-28', 'Episódico'),
        ])],
        imgs: [I('Herpes simple', 'labio superior')],
      }),
      E('2022-07-12', 'Pústulas y forúnculos en glúteos; compañero del gimnasio con infección similar.', {
        dx: [Dx('Foliculitis bacteriana', false, 'Foliculitis/forunculosis por SARM de la comunidad. Resuelta.', [
          T('Antibioterapia oral para SARM', null, '2022-07-22', ''),
        ])],
        labs: [LT('Cultivo de secreción', 'Cultivo bacteriano', 'Staphylococcus aureus resistente a meticilina (SARM), sensible a trimetoprim-sulfametoxazol y doxiciclina.', 'SARM-AC')],
        imgs: [I('Foliculitis bacteriana', 'glúteos')],
      }),
      E('2023-03-02', 'Recurrencias herpéticas muy frecuentes. Se indica terapia supresiva.', {
        seg: [Seg('Herpes simple', [T('Antiviral para herpes simple', null, null, 'Supresión continua: 400 mg cada 12 h', [['Aciclovir 400 mg', '400 mg', 'cada 12 horas (supresión)']])])],
      }),
    ] },

  // -------------------------------------------------------------------
  { codigo: 'DERM-0015', nombre: 'Gloria Inés Marín Henao', nacimiento: '1955-01-17', residencia: ['Colombia', 'Manizales'],
    alergias: [['Penicilinas', 'Urticaria y edema labial']],
    episodios: [
      E('2013-09-09', 'Masa blanda indolora de 4 cm en espalda, crecimiento lento.', {
        dx: [Dx('Lipoma', false, 'Lipoma subcutáneo. Extirpado.', [
          T('Escisión quirúrgica con márgenes', '2013-10-01', '2013-10-01', ''),
        ])],
        labs: [LT('Ecografía de tejidos blandos', 'Ecografía', 'Lesión ovalada hiperecoica de 4 x 2.5 cm, encapsulada, sin vascularización.', 'Compatible con lipoma')],
        imgs: [I('Lipoma', 'espalda alta')],
      }),
      E('2018-02-26', 'Lesiones marrones de aspecto pegado en cara y tronco.', {
        dx: [Dx('Queratosis seborreica', true, 'Queratosis seborreicas múltiples; aparecen nuevas cada año.', [
          T('Crioterapia con nitrógeno líquido', null, '2018-02-26', 'Lesiones irritadas'),
          T('Seguimiento dermatoscópico', null, null, 'Control anual'),
        ])],
        imgs: [I('Queratosis seborreica', 'sien derecha')],
      }),
      E('2021-08-30', 'Vesículas en banda en hemiabdomen derecho con dolor intenso.', {
        dx: [Dx('Herpes zóster', false, 'Herpes zóster T10. Resuelto.', [
          T('Antiviral y analgesia para herpes zóster', null, '2021-09-13', ''),
        ])],
        imgs: [I('Herpes zóster', 'hemiabdomen derecho')],
      }),
      E('2025-05-12', 'Lunar en pierna derecha de 6 mm, dos tonos de marrón.', {
        dx: [Dx('Nevus melanocítico', true, 'Nevus displásico en vigilancia. Sin criterios de malignidad por ahora.', [
          T('Seguimiento dermatoscópico', null, null, 'Control cada 6 meses'),
        ])],
        imgs: [I('Nevus melanocítico', 'pierna derecha')],
      }),
    ] },

  // -------------------------------------------------------------------
  { codigo: 'DERM-0016', nombre: 'Felipe Giraldo Mejía', nacimiento: '1990-08-08', residencia: ['Colombia', 'Bogotá'],
    alergias: [['Propilenglicol', 'Dermatitis de contacto con excipientes de lociones']],
    episodios: [
      E('2021-02-15', 'Retroceso de entradas y pérdida de densidad en coronilla. Padre calvo a los 35.', {
        dx: [Dx('Alopecia androgenética', true, 'Alopecia androgenética Hamilton III vertex.', [
          T('Tratamiento de la alopecia androgenética', null, '2023-01-20', 'Suspendido por dermatitis de contacto al excipiente'),
        ])],
        imgs: [I('Alopecia androgenética', 'vértex')],
      }),
      E('2023-01-20', 'Prurito, eritema y descamación en cuero cabelludo tras 2 años de minoxidil.', {
        dx: [Dx('Dermatitis de contacto alérgica', false, 'Dermatitis de contacto alérgica a propilenglicol de la solución de minoxidil. Resuelta.', [
          T('Corticoterapia tópica de potencia media', null, '2023-02-03', ''),
        ])],
        labs: [LT('Pruebas epicutáneas', 'Patch test (excipientes)', 'Propilenglicol 5%: positivo ++. Minoxidil puro: negativo.', 'Alergia al excipiente')],
        imgs: [I('Dermatitis de contacto alérgica', 'cuero cabelludo')],
      }),
      E('2025-03-03', 'Prurito nocturno intenso; vive en residencia universitaria con otros casos.', {
        dx: [Dx('Escabiosis', false, 'Escabiosis en brote institucional. Curada.', [
          T('Escabicida oral', null, '2025-03-10', 'Dos dosis'),
          T('Escabicida tópico', null, '2025-03-10', ''),
        ])],
        labs: [LT('Examen directo', 'Dermatoscopia', 'Signo del ala delta en surco de muñeca.', 'Compatible con escabiosis')],
        imgs: [I('Escabiosis', 'muñeca derecha')],
      }),
    ] },

  // -------------------------------------------------------------------
  { codigo: 'DERM-0017', nombre: 'Isabella Correa Restrepo', nacimiento: '2008-04-02', residencia: ['Colombia', 'Manizales'],
    alergias: [],
    episodios: [
      E('2019-05-27', 'Niña con eccema en cara y pliegues desde la lactancia.', {
        dx: [Dx('Dermatitis atópica', true, 'Dermatitis atópica moderada.', [
          T('Inmunomodulador tópico', null, null, 'Proactivo 2 veces/semana'),
          T('Emolientes y queratolíticos', null, null, ''),
        ])],
        labs: [L('Inmunoglobulina E sérica', 'IgE total (UI/mL)', 410, 'Elevada')],
        imgs: [I('Dermatitis atópica', 'párpados')],
      }),
      E('2022-10-10', 'Comedones y pápulas en frente.', {
        dx: [Dx('Acné vulgar', true, 'Acné leve de la adolescencia.', [
          T('Tratamiento tópico del acné', null, null, ''),
        ])],
        imgs: [I('Acné vulgar', 'frente')],
      }),
      E('2024-08-05', 'Costras melicéricas peribucales sobre eccema.', {
        dx: [Dx('Impétigo', false, 'Impétigo sobre dermatitis atópica. Resuelto.', [
          T('Antibioterapia tópica', null, '2024-08-15', ''),
          T('Antibioterapia oral antiestafilocócica', null, '2024-08-12', ''),
        ])],
        labs: [LT('Cultivo de secreción', 'Cultivo bacteriano', 'Staphylococcus aureus sensible a meticilina.', '')],
        imgs: [I('Impétigo', 'región peribucal')],
      }),
    ] },

  // -------------------------------------------------------------------
  { codigo: 'DERM-0018', nombre: 'Ricardo Alonso Peña Quintero', nacimiento: '1968-06-12', residencia: ['Colombia', 'Cali'],
    alergias: [['Látex', 'Urticaria de contacto']],
    episodios: [
      E('2010-01-25', 'Placas psoriásicas extensas en tronco, cuero cabelludo y extremidades.', {
        dx: [Dx('Psoriasis en placas', true, 'Psoriasis en placas severa, BSA 22%.', [
          T('Terapia tópica combinada para psoriasis', null, '2012-03-01', ''),
          T('Fototerapia UVB de banda estrecha', '2012-03-01', '2013-06-30', 'Respuesta transitoria'),
        ])],
        labs: [L('Índice de severidad', 'PASI', 21, 'Severa')],
        imgs: [I('Psoriasis en placas', 'tronco posterior')],
      }),
      E('2019-04-08', 'Recaída severa. Se inicia adalimumab tras tamizaje de TB.', {
        seg: [Seg('Psoriasis en placas', [T('Terapia biológica anti-TNF', null, null, 'Adalimumab')])],
        labs: [LT('Tamizaje de tuberculosis', 'IGRA (QuantiFERON-TB Gold)', 'Resultado NEGATIVO.', ''),
               L('Índice de severidad', 'PASI', 18.4, 'Severa')],
      }),
      E('2021-11-15', 'Pierna derecha eritematosa, caliente y dolorosa, con fiebre. En adalimumab.', {
        dx: [Dx('Celulitis', false, 'Celulitis en paciente con biológico. Adalimumab suspendido 3 semanas. Resuelta.', [
          T('Antibioterapia oral antiestafilocócica', null, '2021-11-25', ''),
        ])],
        labs: [L('Reactantes de fase aguda', 'Proteína C reactiva (mg/L)', 112, 'Elevada'),
               L('Hemograma', 'Leucocitos (/µL)', 15800, 'Leucocitosis')],
        imgs: [I('Celulitis', 'pierna derecha')],
      }),
      E('2024-06-03', 'Vesículas en banda lumbar izquierda, dolor urente.', {
        dx: [Dx('Herpes zóster', false, 'Herpes zóster L1 en paciente con anti-TNF. Resuelto.', [
          T('Antiviral y analgesia para herpes zóster', null, '2024-06-17', ''),
        ])],
        imgs: [I('Herpes zóster', 'región lumbar izquierda')],
      }),
      E('2026-03-16', 'Control: psoriasis controlada, PASI 3.', {
        labs: [L('Índice de severidad', 'PASI', 3, 'Controlada'),
               LT('Tamizaje de tuberculosis', 'IGRA (QuantiFERON-TB Gold)', 'Resultado NEGATIVO (control anual).', '')],
      }),
    ] },

  // -------------------------------------------------------------------
  { codigo: 'DERM-0019', nombre: 'Paula Andrea Henao Ríos', nacimiento: '1983-12-21', residencia: ['Colombia', 'Manizales'],
    alergias: [],
    episodios: [
      E('2017-08-14', 'Manchas blancas simétricas en rodillas y alrededor de la boca.', {
        dx: [Dx('Vitíligo', true, 'Vitíligo no segmentario estable.', [
          T('Inmunomodulador tópico', null, '2019-08-14', 'Repigmentación parcial'),
          T('Fototerapia UVB de banda estrecha', '2017-10-01', '2018-10-01', ''),
        ])],
        imgs: [I('Vitíligo', 'rodillas'), I('Vitíligo', 'región perioral')],
      }),
      E('2021-03-29', 'Placas eritematosas descamativas en cara y escote que empeoran con el sol.', {
        dx: [Dx('Lupus eritematoso cutáneo', true, 'Lupus eritematoso cutáneo subagudo. Comorbilidad autoinmune con vitíligo.', [
          T('Terapia antipalúdica', null, null, 'Hidroxicloroquina continua'),
          T('Corticoterapia tópica de potencia media', null, '2021-05-01', ''),
        ])],
        labs: [LT('Inmunología', 'Anticuerpos antinucleares (ANA)', 'ANA positivo 1:320 patrón moteado. Anti-Ro/SSA positivo.', ''),
               L('Electrocardiograma', 'QTc (ms)', 445, 'Normal-alto')],
        imgs: [I('Lupus eritematoso cutáneo', 'escote')],
      }),
      E('2026-10-20', 'Placas rojas húmedas en pliegues inguinales.', {
        dx: [Dx('Candidiasis cutánea', true, 'Candidiasis intertriginosa en tratamiento. Evitar fluconazol por QT con hidroxicloroquina.', [
          T('Antifúngico tópico', null, null, 'En curso'),
        ])],
        labs: [LT('Examen directo', 'KOH', 'Pseudohifas.', 'Positivo')],
        imgs: [I('Candidiasis cutánea', 'pliegue inguinal')],
      }),
    ] },

  // -------------------------------------------------------------------
  { codigo: 'DERM-0020', nombre: 'Óscar Darío Bedoya Franco', nacimiento: '1958-09-03', defuncion: '2025-01-30', residencia: ['Colombia', 'Pereira'],
    alergias: [],
    episodios: [
      E('2012-04-16', 'Lesiones verrugosas marrones en tronco.', {
        dx: [Dx('Queratosis seborreica', false, 'Queratosis seborreicas. Tratadas.', [
          T('Crioterapia con nitrógeno líquido', null, '2012-04-16', ''),
        ])],
        imgs: [I('Queratosis seborreica', 'tronco')],
      }),
      E('2019-07-22', 'Placa queratósica ulcerada en pabellón auricular derecho.', {
        dx: [Dx('Carcinoma espinocelular', false, 'Carcinoma espinocelular de oreja. Extirpado; recidivó en 2023.', [
          T('Escisión quirúrgica con márgenes', '2019-08-05', '2019-08-05', ''),
        ])],
        labs: [LT('Biopsia de piel', 'Histopatología', 'Carcinoma escamocelular moderadamente diferenciado, espesor 5 mm, márgenes libres.', 'Alto riesgo por localización')],
        imgs: [I('Carcinoma espinocelular', 'oreja derecha')],
      }),
      E('2023-09-11', 'Nódulo ulcerado en cicatriz previa y adenopatía cervical.', {
        dx: [Dx('Carcinoma espinocelular', false, 'Recidiva local con metástasis ganglionar cervical. Manejo por oncología; falleció en 2025.', [
          T('Escisión quirúrgica con márgenes', '2023-10-02', '2023-10-02', 'Con vaciamiento cervical'),
        ])],
        labs: [LT('Biopsia de ganglio', 'Histopatología', 'Metástasis de carcinoma escamocelular en 3 de 22 ganglios.', 'pN2b')],
        imgs: [I('Carcinoma espinocelular', 'oreja derecha (recidiva)')],
      }),
    ] },

  // -------------------------------------------------------------------
  { codigo: 'DERM-0021', nombre: 'Mariana Velásquez Ocampo', nacimiento: '2019-02-14', residencia: ['Colombia', 'Manizales'],
    alergias: [['Penicilinas', 'Exantema con amoxicilina a los 2 años']],
    episodios: [
      E('2021-06-07', 'Eccema en mejillas y pliegues con piel muy seca.', {
        dx: [Dx('Dermatitis atópica', true, 'Dermatitis atópica infantil.', [
          T('Corticoterapia tópica de baja potencia', null, '2021-06-28', ''),
          T('Emolientes y queratolíticos', null, null, ''),
        ])],
        imgs: [I('Dermatitis atópica', 'mejillas')],
      }),
      E('2023-02-20', 'Vesículas umbilicadas y erosiones sobre el eccema de cara con fiebre.', {
        dx: [Dx('Herpes simple', false, 'Eccema herpético. Hospitalización 3 días. Resuelto.', [
          T('Antiviral para herpes simple', null, '2023-02-27', 'Dosis pediátrica'),
        ])],
        labs: [LT('PCR viral', 'PCR VHS-1/VHS-2', 'Positiva para VHS-1.', '')],
        imgs: [I('Herpes simple', 'mejilla derecha')],
      }),
      E('2025-09-15', 'Pápulas pruriginosas en manos y abdomen; contagio en jardín infantil.', {
        dx: [Dx('Escabiosis', false, 'Escabiosis. Curada.', [
          T('Escabicida tópico', null, '2025-09-22', 'Ivermectina no indicada por peso < 15 kg'),
        ])],
        imgs: [I('Escabiosis', 'abdomen')],
      }),
    ] },

  // -------------------------------------------------------------------
  { codigo: 'DERM-0022', nombre: 'Esteban Cardona Loaiza', nacimiento: '2000-01-27', residencia: ['Colombia', 'Manizales'],
    alergias: [],
    episodios: [
      E('2016-04-04', 'Acné papulopustuloso en cara y espalda.', {
        dx: [Dx('Acné vulgar', false, 'Acné vulgar que requirió isotretinoína. Curado.', [
          T('Antibioterapia oral para acné y rosácea', null, '2016-07-04', ''),
        ])],
        imgs: [I('Acné vulgar', 'espalda')],
      }),
      E('2018-02-12', 'Acné nódulo-quístico recalcitrante. Isotretinoína 7 meses.', {
        seg: [Seg('Acné vulgar', [T('Retinoide oral para acné severo', null, '2018-09-12', 'Dosis acumulada 130 mg/kg')])],
        labs: [L('Perfil lipídico', 'Triglicéridos (mg/dL)', 140, 'Normal'),
               L('Perfil hepático', 'ALT (U/L)', 26, 'Normal')],
      }),
      E('2026-09-28', 'Descamación en planta y uñas engrosadas de ambos pies, futbolista.', {
        dx: [Dx('Tiña pedis', true, 'Tiña pedis en mocasín con onicomicosis.', [
          T('Antifúngico oral para dermatofitos', null, null, 'En curso, 12 semanas por compromiso ungueal'),
        ])],
        labs: [LT('Examen directo', 'KOH', 'Hifas septadas en escamas y uña.', 'Positivo'),
               L('Perfil hepático', 'ALT (U/L)', 24, 'Basal normal')],
        imgs: [I('Tiña pedis', 'planta del pie izquierdo')],
      }),
    ] },

  // -------------------------------------------------------------------
  { codigo: 'DERM-0023', nombre: 'Rosa Elena Quintero Gallego', nacimiento: '1945-05-30', residencia: ['Colombia', 'Manizales'],
    alergias: [['Sulfonamidas', 'Exantema']],
    episodios: [
      E('2020-02-03', 'Dolor torácico derecho seguido de vesículas en banda.', {
        dx: [Dx('Herpes zóster', false, 'Herpes zóster T6. Neuralgia postherpética 6 meses. Resuelto.', [
          T('Antiviral y analgesia para herpes zóster', null, '2020-08-03', 'Pregabalina 6 meses', ['solo', 'Valaciclovir 1 g', 'Pregabalina 75 mg']),
        ])],
        imgs: [I('Herpes zóster', 'hemitórax derecho')],
      }),
      E('2022-11-21', 'Úlcera perlada en mejilla izquierda de crecimiento lento.', {
        dx: [Dx('Carcinoma basocelular', false, 'Carcinoma basocelular nodular-ulcerado. Extirpado.', [
          T('Escisión quirúrgica con márgenes', '2022-12-12', '2022-12-12', 'Cirugía de Mohs'),
        ])],
        labs: [LT('Biopsia de piel', 'Histopatología', 'Carcinoma basocelular nodular ulcerado; márgenes libres.', '')],
        imgs: [I('Carcinoma basocelular', 'mejilla izquierda')],
      }),
      E('2025-12-01', 'Nuevas lesiones marrones de aspecto pegado en cara.', {
        dx: [Dx('Queratosis seborreica', true, 'Queratosis seborreicas en seguimiento.', [
          T('Seguimiento dermatoscópico', null, null, 'Control anual por antecedente de CBC'),
        ])],
        imgs: [I('Queratosis seborreica', 'frente')],
      }),
    ] },

  // -------------------------------------------------------------------
  { codigo: 'DERM-0024', nombre: 'Diego Fernando Paredes Andrade', nacimiento: '1987-07-11', residencia: ['Ecuador', 'Quito'],
    alergias: [],
    episodios: [
      E('2019-09-02', 'Eccema en manos tras usar guantes de trabajo nuevos.', {
        dx: [Dx('Dermatitis de contacto alérgica', false, 'Dermatitis de contacto ocupacional a aditivos del caucho. Resuelta.', [
          T('Corticoterapia tópica de potencia media', null, '2019-09-23', ''),
        ])],
        labs: [LT('Pruebas epicutáneas', 'Patch test (batería estándar)', 'Mezcla de tiuram: positivo ++.', 'Alergia a aceleradores del caucho')],
        imgs: [I('Dermatitis de contacto alérgica', 'dorso de manos')],
      }),
      E('2023-05-15', 'Placas escamosas en codos, rodillas y región sacra.', {
        dx: [Dx('Psoriasis en placas', true, 'Psoriasis en placas leve, BSA 4%.', [
          T('Terapia tópica combinada para psoriasis', null, null, 'Uso intermitente en brotes'),
        ])],
        labs: [L('Índice de severidad', 'PASI', 5.2, 'Leve')],
        imgs: [I('Psoriasis en placas', 'rodilla derecha')],
      }),
    ] },
];

// ---------------------------------------------------------------------
// Construcción de documentos
// ---------------------------------------------------------------------
const docs = { pacientes: [], historias_medicas: [], diagnosticos_asignados: [], imagenes: [], resultados_laboratorio: [] };

function edad(nac, fecha) { return (F(fecha) - F(nac)) / (365.25 * 24 * 3600 * 1000); }
function slug(s) { return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); }

function construirTratamiento(t, fechaEp, pac) {
  const trat = req(TR, t.nombre, 'Tratamiento');
  const inicio = t.inicio || fechaEp;
  const nino = edad(pac.nacimiento, inicio) < 12;
  let meds;
  if (Array.isArray(t.meds) && t.meds[0] !== 'solo') {
    meds = t.meds.map(([n, cantidad, frecuencia]) => ({ medicamento_id: req(MED, n, 'Medicamento')._id, cantidad, frecuencia }));
  } else {
    const solo = Array.isArray(t.meds) ? t.meds.slice(1).map((n) => req(MED, n, 'Medicamento')._id.toString()) : null;
    meds = trat.medicamentos
      .filter((m) => !solo || solo.includes(m.medicamento_id.toString()))
      .map((m) => {
        const pautas = m.pautas_generales;
        const p = pautas.find((x) => (nino ? x.grupo_poblacional.startsWith('Niños') : !x.grupo_poblacional.startsWith('Niños'))) || pautas[0];
        return { medicamento_id: m.medicamento_id, cantidad: p.cantidad, frecuencia: p.frecuencia };
      });
  }
  if (t.fin && F(t.fin) < F(inicio)) throw new Error(`${pac.codigo}: fin antes del inicio en ${t.nombre}`);
  if (pac.defuncion && !t.fin) throw new Error(`${pac.codigo}: paciente fallecido con tratamiento vigente (${t.nombre})`);
  return {
    tratamiento_id: trat._id, fecha_inicio: F(inicio), fecha_fin: t.fin ? F(t.fin) : null,
    vigente: !t.fin, observaciones: t.observaciones || '', medicamentos: meds,
  };
}

PACIENTES.forEach((p) => {
  const pid = new ObjectId();
  const hid = new ObjectId();
  const dxaDelPaciente = [];
  const historia = { _id: hid, paciente_id: pid, episodios: [] };
  let nImg = 0;

  p.episodios.forEach((ep) => {
    const fechaEp = F(ep.fecha);
    const episodio = { fecha: fechaEp, observaciones: ep.observaciones, diagnosticos_asignados_ids: [], imagenes_ids: [], resultados_laboratorio_ids: [] };

    ep.dx.forEach((d) => {
      const dxCat = req(DX, d.nombre, 'Diagnóstico');
      const trats = d.trats.map((t) => construirTratamiento(t, ep.fecha, p));
      if (!d.vigente && trats.some((t) => t.vigente)) throw new Error(`${p.codigo}: diagnóstico cerrado con tratamiento vigente (${d.nombre})`);
      const doc = {
        _id: new ObjectId(), paciente_id: pid, historia_medica_id: hid, episodio_fecha: fechaEp,
        diagnostico_id: dxCat._id, fecha_diagnostico: fechaEp, vigente: d.vigente,
        observaciones: d.observaciones, tratamientos_asignados: trats,
      };
      docs.diagnosticos_asignados.push(doc);
      dxaDelPaciente.push({ nombre: d.nombre, doc });
      episodio.diagnosticos_asignados_ids.push(doc._id);
    });

    ep.seg.forEach((s) => {
      const previo = dxaDelPaciente.filter((x) => x.nombre === s.nombre).pop();
      if (!previo) throw new Error(`${p.codigo}: seguimiento de diagnóstico no asignado (${s.nombre})`);
      s.trats.forEach((t) => {
        const tr = construirTratamiento(t, ep.fecha, p);
        if (!previo.doc.vigente && tr.vigente) throw new Error(`${p.codigo}: tratamiento vigente sobre diagnóstico cerrado`);
        previo.doc.tratamientos_asignados.push(tr);
      });
      if (!episodio.diagnosticos_asignados_ids.some((id) => id.equals(previo.doc._id))) episodio.diagnosticos_asignados_ids.push(previo.doc._id);
    });

    ep.labs.forEach((l) => {
      const doc = {
        _id: new ObjectId(), paciente_id: pid, historia_medica_id: hid, fecha: fechaEp,
        tipo_examen: l.tipo, formato: l.formato,
        resultado: { parametro: l.parametro, valor: l.valor, observaciones: l.observaciones || '' },
      };
      docs.resultados_laboratorio.push(doc);
      episodio.resultados_laboratorio_ids.push(doc._id);
    });

    ep.imgs.forEach((im) => {
      const dxCat = req(DX, im.dx, 'Diagnóstico');
      const [colores, texturas] = VISUAL[im.dx];
      nImg += 1;
      const doc = {
        _id: new ObjectId(), paciente_id: pid, historia_medica_id: hid, episodio_fecha: fechaEp,
        diagnostico_id: dxCat._id,
        archivo: `imagenes/pacientes/${p.codigo}/${ep.fecha}_${slug(im.dx)}_${String(nImg).padStart(2, '0')}.jpg`,
        embedding_visual: embedding(im.dx, 0.55), fecha_registro: fechaEp,
        descripcion_visual: { colores, texturas, region_corporal: im.region },
      };
      docs.imagenes.push(doc);
      episodio.imagenes_ids.push(doc._id);
    });

    historia.episodios.push(episodio);
  });

  docs.historias_medicas.push(historia);
  docs.pacientes.push({
    _id: pid, codigo_paciente: p.codigo, nombre_completo: p.nombre,
    fecha_nacimiento: F(p.nacimiento), fecha_defuncion: p.defuncion ? F(p.defuncion) : null,
    lugar_residencia: { pais: p.residencia[0], ciudad: p.residencia[1] },
    alergias: p.alergias.map(([sustancia, reaccion]) => ({ sustancia, reaccion })),
    diagnosticos_asignados_ids: dxaDelPaciente.map((x) => x.doc._id),
    historias_clinicas_ids: [hid],
  });
});

// Atlas de referencia: 2 imágenes por diagnóstico, sin paciente
Object.keys(VISUAL).forEach((dx) => {
  const [colores, texturas] = VISUAL[dx];
  [1, 2].forEach((n) => docs.imagenes.push({
    _id: new ObjectId(), paciente_id: null, historia_medica_id: null, episodio_fecha: null,
    diagnostico_id: req(DX, dx, 'Diagnóstico')._id,
    archivo: `imagenes/atlas/${slug(dx)}_${String(n).padStart(2, '0')}.jpg`,
    embedding_visual: embedding(dx, 0.35), fecha_registro: F('2025-01-15'),
    descripcion_visual: { colores, texturas, region_corporal: 'referencia' },
  }));
});

// ---------------------------------------------------------------------
// Inserción
// ---------------------------------------------------------------------
Object.entries(docs).forEach(([col, lista]) => {
  db.getCollection(col).insertMany(lista);
  print(`✔ ${col}: ${lista.length} documentos`);
});
print('✔ Datos de pacientes cargados');
