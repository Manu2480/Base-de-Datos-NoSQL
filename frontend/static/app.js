// ENTREGA II
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const TITLES = {
  resumen: "Centro de conocimiento dermatológico",
  pacientes: "Pacientes",
  registro: "Registro clínico",
  consultas: "Consultas por colección",
  conocimiento: "Conocimiento y RAG",
};

const QUERIES = [
  { id: "patients", title: "Pacientes", path: "/api/patients", hint: "codigo_paciente, nombre_completo, lugar_residencia.ciudad, alergias.sustancia y pacientes vivos.", filters: [["codigo", "Código"], ["nombre", "Nombre"], ["ciudad", "Ciudad"], ["alergia", "Alergia"]], flag: ["solo_vivos", "Solo vivos"], columns: [["codigo_paciente", "Código"], ["nombre_completo", "Nombre"], ["lugar_residencia.ciudad", "Ciudad"]], example: { codigo: "DERM-0001", ciudad: "Manizales", solo_vivos: true } },
  { id: "medications", title: "Medicamentos", path: "/api/medications", hint: "nombre y principio_activo.", filters: [["nombre", "Nombre"], ["principio_activo", "Principio activo"]], columns: [["nombre", "Nombre"], ["principio_activo", "Principio activo"]], example: { principio_activo: "Metotrexato" } },
  { id: "symptoms", title: "Síntomas", path: "/api/symptoms", hint: "nombre del síntoma.", filters: [["nombre", "Nombre"]], columns: [["nombre", "Nombre"], ["descripcion", "Descripción"]], example: { nombre: "Prurito" } },
  { id: "diagnoses", title: "Diagnósticos", path: "/api/diagnosis-catalog", hint: "nombre y categoria del catálogo.", filters: [["nombre", "Nombre"], ["categoria", "Categoría"]], columns: [["nombre", "Nombre"], ["categoria", "Categoría"]], example: { categoria: "Infecciosas" } },
  { id: "treatments", title: "Tratamientos", path: "/api/treatments", hint: "nombre y diagnostico_id (ObjectId del catálogo).", filters: [["nombre", "Nombre"], ["diagnostico_id", "Diagnóstico (ObjectId)"]], columns: [["nombre", "Nombre"], ["descripcion", "Descripción"]], example: { nombre: "Fototerapia" } },
  { id: "assigned", title: "Diagnósticos asignados", path: "/api/assigned-diagnoses", hint: "paciente_id, diagnostico_id y vigente.", filters: [["paciente_id", "Paciente (ObjectId)"], ["diagnostico_id", "Diagnóstico (ObjectId)"]], flag: ["vigente", "Solo vigentes"], columns: [["fecha_diagnostico", "Fecha"], ["vigente", "Vigente"], ["paciente_id", "Paciente"]], example: { vigente: true } },
  { id: "histories", title: "Historias médicas", path: "/api/medical-histories", hint: "paciente_id.", filters: [["paciente_id", "Paciente (ObjectId)"]], columns: [["paciente_id", "Paciente"], ["_id", "Historia"]], example: { paciente_id: "<ObjectId>" } },
  { id: "labs", title: "Laboratorio", path: "/api/laboratory-results", hint: "paciente_id, tipo_examen, formato (JSON o TXT) y rango de fecha.", filters: [["paciente_id", "Paciente (ObjectId)"], ["tipo_examen", "Tipo de examen"], ["formato", "Formato", ["", "JSON", "TXT"]], ["fecha_desde", "Desde", "date"], ["fecha_hasta", "Hasta", "date"]], columns: [["tipo_examen", "Examen"], ["formato", "Formato"], ["fecha", "Fecha"], ["resultado.parametro", "Parámetro"], ["resultado.valor", "Valor"]], example: { tipo_examen: "Biopsia", formato: "JSON" } },
  { id: "images", title: "Imágenes", path: "/api/clinical-images", hint: "paciente_id, diagnostico_id y descripcion_visual.region_corporal. No devuelve el embedding.", filters: [["paciente_id", "Paciente (ObjectId)"], ["diagnostico_id", "Diagnóstico (ObjectId)"], ["region", "Región corporal"]], columns: [["archivo", "Archivo"], ["descripcion_visual.region_corporal", "Región"], ["fecha_registro", "Fecha"]], example: { region: "referencia" } },
  { id: "knowledge", title: "Documentos", path: "/api/knowledge-documents", hint: "tema, categoria, idioma y diagnostico_id.", filters: [["tema", "Tema"], ["categoria", "Categoría"], ["idioma", "Idioma"], ["diagnostico_id", "Diagnóstico (ObjectId)"]], columns: [["titulo", "Título"], ["tema", "Tema"], ["categoria", "Categoría"]], example: { tema: "psoriasis-en-placas", categoria: "descripcion" } },
  { id: "chunks", title: "Fragmentos", path: "/api/chunks", hint: "doc_id, estrategia_chunking e idioma. No devuelve el embedding.", filters: [["doc_id", "Documento (ObjectId)"], ["estrategia_chunking", "Estrategia", ["", "fixed-size", "sentence-aware", "semantic"]], ["idioma", "Idioma"]], columns: [["estrategia_chunking", "Estrategia"], ["chunk_index", "Índice"], ["chunk_texto", "Texto"]], example: { estrategia_chunking: "sentence-aware", idioma: "es" } },
  { id: "users", title: "Usuarios", path: "/api/users", hint: "nombre y correo.", filters: [["nombre", "Nombre"], ["correo", "Correo"]], columns: [["nombre", "Nombre"], ["correo", "Correo"]], example: { correo: "ucaldas.edu.co" } },
  { id: "stored", title: "Consultas guardadas", path: "/api/stored-queries", hint: "Colección consultas. Aún no tiene atributos de filtro propios.", filters: [], columns: [["_id", "Id"]], example: {} },
  { id: "evaluations", title: "Evaluaciones", path: "/api/evaluations", hint: "Colección evaluaciones. Aún no tiene atributos de filtro propios.", filters: [], columns: [["_id", "Id"]], example: {} },
];

let activeQuery = QUERIES[0];
let catalog = { patients: [], diagnoses: [], symptoms: [] };

const toast = (message) => {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  window.setTimeout(() => node.classList.remove("show"), 3800);
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[character]);
}

function errorMessage(data, status) {
  const detail = data?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((item) => item.msg).join(" ");
  return `Error HTTP ${status}`;
}

async function request(path, options = {}) {
  const response = await fetch(path, options);
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(errorMessage(data, response.status));
  return data;
}

function showView(name) {
  $$(".view").forEach((view) => {
    const active = view.id === `view-${name}`;
    view.classList.toggle("active", active);
    view.hidden = !active;
  });
  $$(".nav-link").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  $("#view-title").textContent = TITLES[name];
  window.scrollTo(0, 0);
  if (name === "registro") loadCatalogs().catch((error) => toast(error.message));
  if (name === "consultas") renderQuery(activeQuery);
}

function valueAt(item, path) {
  const value = path.split(".").reduce((current, key) => current?.[key], item);
  if (value == null || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function renderTable(items, columns) {
  if (!items.length) return '<p class="muted">No hay documentos con esos filtros.</p>';
  const head = columns.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join("");
  const body = items.map((item) => `<tr>${columns.map(([key]) => `<td>${escapeHtml(valueAt(item, key))}</td>`).join("")}</tr>`).join("");
  return `<table class="data-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

async function loadDashboard() {
  try {
    const [health, dashboard] = await Promise.all([request("/api/health"), request("/api/dashboard")]);
    const state = health.mongodb === "connected";
    $("#connection-state").textContent = state ? "Activa" : "Desconectada";
    $("#database-name").textContent = dashboard.database;
    $("#sidebar-status").textContent = state ? "MongoDB conectado" : "MongoDB sin conexión";
    $("#status-dot").classList.toggle("online", state);
    const counts = Object.fromEntries(dashboard.collections.map((item) => [item.name, item.count]));
    $("#documents-count").textContent = counts.documentos_conocimiento ?? 0;
    $("#chunks-count").textContent = counts.chunks ?? 0;
    $("#images-count").textContent = counts.imagenes ?? 0;
    $("#collection-grid").innerHTML = dashboard.collections.map((item) => `
      <div class="collection-item"><strong>${escapeHtml(item.name)}</strong><span>${item.count.toLocaleString("es-CO")} documentos</span></div>
    `).join("");
  } catch (error) {
    $("#connection-state").textContent = "Sin conexión";
    $("#sidebar-status").textContent = "MongoDB sin conexión";
    $("#status-dot").classList.remove("online");
    $("#collection-grid").innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
  }
}

function patientFilterPayload(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  if (form.solo_vivos?.checked) data.solo_vivos = true;
  else delete data.solo_vivos;
  Object.keys(data).forEach((key) => { if (!data[key]) delete data[key]; });
  return data;
}

function renderPatients(items) {
  if (!items.length) {
    $("#patient-results").innerHTML = '<p class="muted">No hay pacientes con esos filtros.</p>';
    return;
  }
  $("#patient-results").innerHTML = `<div class="patient-list">${items.map((item) => `
    <article class="patient-card">
      <div>
        <strong>${escapeHtml(item.nombre_completo)}</strong>
        <small>${escapeHtml(item.codigo_paciente)} · ${escapeHtml(item.lugar_residencia?.ciudad || "sin ciudad")}</small>
      </div>
      <button class="button button-outline" type="button" data-profile="${escapeHtml(item._id)}">Ver perfil</button>
    </article>
  `).join("")}</div>`;
}

async function openProfile(patientId) {
  const profile = await request(`/api/patients/${patientId}/profile`);
  const patient = profile.patient;
  const allergies = (patient.alergias || []).map((item) => `<span class="chip">${escapeHtml(item.sustancia)}${item.reaccion ? ` · ${escapeHtml(item.reaccion)}` : ""}</span>`).join("") || "<span class='muted'>Sin alergias registradas</span>";
  const diagnoses = profile.assigned_diagnoses.map((item) => {
    const name = item.diagnostico_id ? (item.diagnostico?.nombre || "Diagnóstico") : "Sin diagnóstico";
    return `<li><strong>${escapeHtml(name)}</strong> · ${item.vigente ? "vigente" : "cerrado"} · ${(item.sintomas || []).map(escapeHtml).join(", ") || "sin síntomas asociados en el episodio"}</li>`;
  }).join("") || "<li>Sin diagnósticos asignados</li>";
  const histories = profile.medical_histories.map((item) => `<li>${(item.episodios || []).length} episodio(s) · ${escapeHtml(item._id)}</li>`).join("") || "<li>Sin historia</li>";
  const labs = profile.laboratory_results.map((item) => `<li>${escapeHtml(item.tipo_examen)} · ${escapeHtml(item.resultado?.parametro)} ${escapeHtml(item.resultado?.valor)}</li>`).join("") || "<li>Sin exámenes</li>";
  const images = profile.images.map((item) => `<li>${escapeHtml(item.descripcion_visual?.region_corporal || "región")} · ${escapeHtml(item.archivo)}</li>`).join("") || "<li>Sin imágenes del paciente</li>";
  $("#patient-list-panel").hidden = true;
  $("#patient-profile").hidden = false;
  $("#patient-profile").innerHTML = `
    <article class="panel">
      <div class="profile-head">
        <div>
          <span class="eyebrow">PERFIL</span>
          <h2>${escapeHtml(patient.nombre_completo)}</h2>
          <p class="muted">${escapeHtml(patient.codigo_paciente)} · ${escapeHtml(patient.lugar_residencia?.ciudad || "")}, ${escapeHtml(patient.lugar_residencia?.pais || "")}</p>
          <div class="chip-row">${allergies}</div>
        </div>
        <button class="button button-outline" type="button" id="close-profile">Volver al listado</button>
      </div>
      <div class="profile-grid">
        <section class="profile-block"><h3>Diagnósticos</h3><ul>${diagnoses}</ul></section>
        <section class="profile-block"><h3>Historias</h3><ul>${histories}</ul></section>
        <section class="profile-block"><h3>Laboratorio</h3><ul>${labs}</ul></section>
        <section class="profile-block"><h3>Imágenes</h3><ul>${images}</ul></section>
      </div>
    </article>`;
  $("#close-profile").addEventListener("click", () => {
    $("#patient-profile").hidden = true;
    $("#patient-list-panel").hidden = false;
  });
}

function queryParams(query, form) {
  const params = new URLSearchParams();
  const body = {};
  new FormData(form).forEach((value, key) => {
    if (String(value).trim()) {
      params.set(key, value);
      body[key] = value;
    }
  });
  if (query.flag && form.elements[query.flag[0]]?.checked) {
    params.set(query.flag[0], "true");
    body[query.flag[0]] = true;
  }
  return { params, body };
}

function renderQuery(query) {
  activeQuery = query;
  $$(".query-link").forEach((button) => button.classList.toggle("active", button.dataset.query === query.id));
  $("#query-title").textContent = query.title;
  $("#query-hint").textContent = query.hint;
  const fields = query.filters.map(([name, label, kind]) => {
    if (Array.isArray(kind)) {
      const options = kind.map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option || "Cualquiera")}</option>`).join("");
      return `<label>${escapeHtml(label)}<select name="${escapeHtml(name)}">${options}</select></label>`;
    }
    const type = kind === "date" ? "date" : "text";
    return `<label>${escapeHtml(label)}<input name="${escapeHtml(name)}" type="${type}"></label>`;
  }).join("");
  const flag = query.flag ? `<label class="check"><input type="checkbox" name="${query.flag[0]}"> ${escapeHtml(query.flag[1])}</label>` : "";
  $("#query-form").innerHTML = `${fields}${flag}<button class="button button-primary" type="submit">Consultar</button>`;
  $("#query-json").textContent = `GET ${query.path}\n${JSON.stringify(query.example, null, 2)}`;
  $("#query-results").innerHTML = "";
}

function fillSelect(select, items, label, emptyLabel = "Selecciona") {
  select.innerHTML = `<option value="">${escapeHtml(emptyLabel)}</option>${items.map((item) => `<option value="${escapeHtml(item._id)}">${escapeHtml(label(item))}</option>`).join("")}`;
}

async function loadHistories(patientId, select) {
  if (!patientId) {
    select.innerHTML = "<option value=''>Selecciona un paciente</option>";
    return;
  }
  const data = await request(`/api/medical-histories?paciente_id=${encodeURIComponent(patientId)}`);
  fillSelect(select, data.items, (item) => `${(item.episodios || []).length} episodio(s) · ${item._id}`);
}

async function loadCatalogs() {
  const [patients, diagnoses, symptoms] = await Promise.all([
    request("/api/patients"),
    request("/api/diagnosis-catalog"),
    request("/api/symptoms"),
  ]);
  catalog = { patients: patients.items, diagnoses: diagnoses.items, symptoms: symptoms.items };
  ["history-patient", "assign-patient", "lab-patient"].forEach((id) => {
    fillSelect($( `#${id}`), catalog.patients, (item) => `${item.codigo_paciente} · ${item.nombre_completo}`);
  });
  fillSelect($("#assign-diagnosis-select"), catalog.diagnoses, (item) => `${item.nombre} · ${item.categoria || ""}`, "Sin diagnóstico");
  $("#symptom-checks").innerHTML = catalog.symptoms.map((item) => `
    <label class="check"><input type="checkbox" name="sintomas_ids" value="${escapeHtml(item._id)}"> ${escapeHtml(item.nombre)}</label>
  `).join("");
}

function showNotice(id, message, isError) {
  const notice = $(id);
  notice.hidden = false;
  notice.classList.toggle("error", isError);
  notice.textContent = message;
}

function jsonBody(payload) {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };
}

$$("[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
$("#refresh-button").addEventListener("click", loadDashboard);

$("#patient-filter").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = patientFilterPayload(event.currentTarget);
  $("#patient-filter-json").textContent = `GET /api/patients\n${JSON.stringify(payload, null, 2)}`;
  const params = new URLSearchParams(payload);
  try {
    const data = await request(`/api/patients?${params.toString()}`);
    renderPatients(data.items);
  } catch (error) {
    $("#patient-results").innerHTML = `<p class="notice error">${escapeHtml(error.message)}</p>`;
  }
});
$("#patient-filter").dispatchEvent(new Event("submit"));

$("#patient-results").addEventListener("click", (event) => {
  const button = event.target.closest("[data-profile]");
  if (!button) return;
  openProfile(button.dataset.profile).catch((error) => toast(error.message));
});

$("#register-tabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-register]");
  if (!button) return;
  $$(".subnav-link").forEach((item) => item.classList.toggle("active", item === button));
  $$(".register-panel").forEach((panel) => {
    const active = panel.id === `register-${button.dataset.register}`;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });
});

function addAllergyRow() {
  const row = document.createElement("div");
  row.className = "allergy-row";
  row.innerHTML = `
    <label>Sustancia<input name="sustancia" placeholder="Penicilina"></label>
    <label>Reacción<input name="reaccion" placeholder="Erupción cutánea"></label>
    <button class="button button-outline" type="button" data-remove-allergy>Quitar</button>`;
  $("#allergy-list").append(row);
}

function allergyValues(form) {
  return [...form.querySelectorAll(".allergy-row")].map((row) => ({
    sustancia: row.querySelector("[name='sustancia']").value.trim(),
    reaccion: row.querySelector("[name='reaccion']").value.trim(),
  })).filter((item) => item.sustancia);
}

function patientPayload(form) {
  const data = new FormData(form);
  return {
    nombre_completo: String(data.get("nombre_completo") || "").trim(),
    fecha_nacimiento: data.get("fecha_nacimiento"),
    lugar_residencia: { pais: data.get("pais"), ciudad: data.get("ciudad") },
    alergias: allergyValues(form),
  };
}

addAllergyRow();
$("#add-allergy").addEventListener("click", () => {
  addAllergyRow();
  $("#create-patient").dispatchEvent(new Event("input"));
});
$("#allergy-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-allergy]");
  if (!button) return;
  button.closest(".allergy-row").remove();
  $("#create-patient").dispatchEvent(new Event("input"));
});
$("#create-patient").addEventListener("input", (event) => {
  $("#create-patient-json").textContent = `POST /api/patients\n${JSON.stringify(patientPayload(event.currentTarget), null, 2)}`;
});
$("#create-patient").dispatchEvent(new Event("input"));
$("#create-patient").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = patientPayload(form);
  try {
    const created = await request("/api/patients", jsonBody(payload));
    showNotice("#create-patient-notice", `Paciente ${created.codigo_paciente} creado.`, false);
    form.reset();
    $("#allergy-list").replaceChildren();
    addAllergyRow();
    form.dispatchEvent(new Event("input"));
    toast(`Paciente ${created.codigo_paciente} creado.`);
  } catch (error) {
    showNotice("#create-patient-notice", error.message, true);
  }
});

$("#create-user").addEventListener("input", (event) => {
  const form = Object.fromEntries(new FormData(event.currentTarget).entries());
  $("#create-user-json").textContent = `POST /api/users\n${JSON.stringify(form, null, 2)}`;
});
$("#create-user").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  try {
    await request("/api/users", jsonBody(payload));
    showNotice("#create-user-notice", "Usuario creado.", false);
    form.reset();
  } catch (error) {
    showNotice("#create-user-notice", error.message, true);
  }
});

$("#create-history").addEventListener("input", (event) => {
  const form = Object.fromEntries(new FormData(event.currentTarget).entries());
  $("#create-history-json").textContent = `POST /api/patients/${form.paciente_id || "{id}"}/histories\n${JSON.stringify({ fecha: form.fecha, observaciones: form.observaciones }, null, 2)}`;
});
$("#create-history").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = Object.fromEntries(new FormData(event.currentTarget).entries());
  try {
    const created = await request(`/api/patients/${form.paciente_id}/histories`, jsonBody({ fecha: form.fecha, observaciones: form.observaciones }));
    showNotice("#create-history-notice", `Historia ${created._id} creada.`, false);
  } catch (error) {
    showNotice("#create-history-notice", error.message, true);
  }
});

function assignPayload(formElement) {
  const form = new FormData(formElement);
  return {
    paciente_id: form.get("paciente_id"),
    historia_medica_id: form.get("historia_medica_id"),
    diagnostico_id: form.get("diagnostico_id") || null,
    fecha_diagnostico: form.get("fecha_diagnostico"),
    vigente: Boolean(formElement.vigente?.checked),
    observaciones: form.get("observaciones") || "",
    sintomas_ids: form.getAll("sintomas_ids"),
  };
}
$("#assign-patient").addEventListener("change", (event) => loadHistories(event.target.value, $("#assign-history")));
$("#assign-diagnosis-select").addEventListener("change", (event) => {
  const diagnosis = catalog.diagnoses.find((item) => item._id === event.target.value);
  const linked = new Set((diagnosis?.sintomas_ids || []).map(String));
  $$("#symptom-checks input").forEach((input) => { input.checked = linked.has(input.value); });
  $("#assign-diagnosis").dispatchEvent(new Event("input"));
});
$("#assign-diagnosis").addEventListener("input", (event) => {
  const payload = assignPayload(event.currentTarget);
  const { paciente_id, ...body } = payload;
  $("#assign-diagnosis-json").textContent = `POST /api/patients/${paciente_id || "{id}"}/assigned-diagnoses\n${JSON.stringify(body, null, 2)}`;
});
$("#assign-diagnosis").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = assignPayload(event.currentTarget);
  const { paciente_id, ...body } = payload;
  try {
    await request(`/api/patients/${paciente_id}/assigned-diagnoses`, jsonBody(body));
    showNotice("#assign-diagnosis-notice", "Diagnóstico y síntomas asociados.", false);
  } catch (error) {
    showNotice("#assign-diagnosis-notice", error.message, true);
  }
});

$("#lab-patient").addEventListener("change", (event) => loadHistories(event.target.value, $("#lab-history")));
$("#create-lab").addEventListener("input", (event) => {
  const form = Object.fromEntries(new FormData(event.currentTarget).entries());
  const body = {
    historia_medica_id: form.historia_medica_id,
    fecha: form.fecha,
    tipo_examen: form.tipo_examen,
    formato: form.formato,
    resultado: { parametro: form.parametro, valor: form.valor, observaciones: form.observaciones || "" },
  };
  $("#create-lab-json").textContent = `POST /api/patients/${form.paciente_id || "{id}"}/laboratory\n${JSON.stringify(body, null, 2)}`;
});
$("#create-lab").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = Object.fromEntries(new FormData(event.currentTarget).entries());
  const body = {
    historia_medica_id: form.historia_medica_id,
    fecha: form.fecha,
    tipo_examen: form.tipo_examen,
    formato: form.formato,
    resultado: { parametro: form.parametro, valor: form.valor, observaciones: form.observaciones || "" },
  };
  try {
    await request(`/api/patients/${form.paciente_id}/laboratory`, jsonBody(body));
    showNotice("#create-lab-notice", "Examen registrado.", false);
  } catch (error) {
    showNotice("#create-lab-notice", error.message, true);
  }
});

$("#query-menu").innerHTML = QUERIES.map((query) => `<button class="query-link" type="button" data-query="${query.id}">${escapeHtml(query.title)}</button>`).join("");
$("#query-menu").addEventListener("click", (event) => {
  const button = event.target.closest("[data-query]");
  if (!button) return;
  renderQuery(QUERIES.find((query) => query.id === button.dataset.query));
});
$("#query-form").addEventListener("input", () => {
  const { body } = queryParams(activeQuery, $("#query-form"));
  $("#query-json").textContent = `GET ${activeQuery.path}\n${JSON.stringify(body, null, 2)}`;
});
$("#query-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const { params } = queryParams(activeQuery, event.currentTarget);
  try {
    const data = await request(`${activeQuery.path}?${params.toString()}`);
    $("#query-results").innerHTML = renderTable(data.items, activeQuery.columns);
  } catch (error) {
    $("#query-results").innerHTML = `<p class="notice error">${escapeHtml(error.message)}</p>`;
  }
});

function renderResults(items, target) {
  if (!items.length) {
    target.innerHTML = '<p class="muted">No se encontraron fragmentos para esta consulta.</p>';
    return;
  }
  target.innerHTML = items.map((item) => `
    <article class="result-item">
      ${item.archivo_file_id && item._id ? `<img class="result-image" src="/api/images/${encodeURIComponent(item._id)}/file" alt="">` : ""}
      <strong>${escapeHtml(item.estrategia_chunking || item.archivo || "Resultado")}</strong>
      <p>${escapeHtml(item.chunk_texto || item.descripcion_visual?.region_corporal || "Imagen relacionada")}</p>
    </article>
  `).join("");
}

async function submitSearch(mode) {
  const form = new FormData($("#search-form"));
  const payload = Object.fromEntries(form.entries());
  payload.modo = mode === "rag" ? "vector" : payload.modo;
  payload.top_k = Number(payload.top_k);
  for (const key of ["estrategia_chunking", "idioma"]) if (!payload[key]) delete payload[key];
  const output = $("#search-results");
  output.innerHTML = '<p class="muted">Buscando en MongoDB…</p>';
  try {
    if (mode === "rag") {
      const result = await request("/api/rag", jsonBody(payload));
      output.innerHTML = `<article class="result-item"><strong>Respuesta</strong><p>${escapeHtml(result.answer)}</p></article>${(result.sources || []).map((source, index) => `<article class="result-item"><strong>Fuente ${index + 1}</strong><p>${escapeHtml(source.chunk_texto)}</p></article>`).join("")}`;
    } else {
      const result = await request("/api/search", jsonBody(payload));
      renderResults(result.results, output);
    }
  } catch (error) {
    output.innerHTML = `<p class="notice error">${escapeHtml(error.message)}</p>`;
  }
}
$("#search-form").addEventListener("submit", (event) => { event.preventDefault(); submitSearch("search"); });
$("#ask-button").addEventListener("click", () => submitSearch("rag"));
$("#ingest-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const payload = Object.fromEntries(data.entries());
  payload.estrategias = data.getAll("estrategias");
  try {
    const result = await request("/api/ingest", jsonBody(payload));
    showNotice("#ingest-notice", `Documento procesado: ${result.chunks_generados} fragmentos.`, false);
    form.reset();
    await loadDashboard();
  } catch (error) {
    showNotice("#ingest-notice", error.message, true);
  }
});
$("#image-text-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = new FormData(event.currentTarget).get("query");
  try {
    const result = await request("/api/images/search-text", jsonBody({ query, top_k: 5 }));
    renderResults(result.results, $("#image-results"));
  } catch (error) {
    $("#image-results").innerHTML = `<p class="notice error">${escapeHtml(error.message)}</p>`;
  }
});
$("#image-file-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await request("/api/images/search", { method: "POST", body: new FormData(event.currentTarget) });
    renderResults(result.results, $("#image-results"));
  } catch (error) {
    $("#image-results").innerHTML = `<p class="notice error">${escapeHtml(error.message)}</p>`;
  }
});
$("#image-upload-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const result = await request("/api/images", { method: "POST", body: new FormData(form) });
    showNotice("#image-upload-notice", `Imagen ${result.archivo} guardada.`, false);
    form.reset();
  } catch (error) {
    showNotice("#image-upload-notice", error.message, true);
  }
});

$("#create-patient").dispatchEvent(new Event("input"));
$("#create-user").dispatchEvent(new Event("input"));
renderQuery(activeQuery);
loadDashboard();
