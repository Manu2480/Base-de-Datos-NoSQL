const $ = (selector) => document.querySelector(selector);
const toast = (message) => {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  window.setTimeout(() => node.classList.remove("show"), 3800);
};

async function request(path, options = {}) {
  const response = await fetch(path, options);
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(data?.detail || `Error HTTP ${response.status}`);
  return data;
}

async function loadDashboard() {
  try {
    const [health, dashboard] = await Promise.all([
      request("/api/health"),
      request("/api/dashboard"),
    ]);
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
    $("#collection-grid").innerHTML = `<p class="muted">${escapeHtml(error.message)}. Configure el archivo .env y ejecute la inicialización.</p>`;
    $("#database-name").textContent = "Verifique MONGODB_URI";
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[character]);
}

function renderResults(items, target) {
  if (!items.length) {
    target.innerHTML = '<p class="muted">No se encontraron fragmentos para esta consulta.</p>';
    return;
  }
  target.innerHTML = items.map((item) => `
    <article class="result-item">
      ${item.archivo_file_id && item._id ? `<img class="result-image" src="/api/images/${encodeURIComponent(item._id)}/file" alt="${escapeHtml(item.archivo || "Imagen relacionada")}" loading="lazy">` : ""}
      <strong>${escapeHtml(item.estrategia_chunking || item.archivo || "Resultado")} · ${item.score == null ? "Coincidencia" : `similitud ${Number(item.score).toFixed(3)}`}</strong>
      <p>${escapeHtml(item.chunk_texto || item.descripcion_visual?.region_corporal || "Imagen relacionada")}</p>
    </article>
  `).join("");
}

$("#refresh-button").addEventListener("click", loadDashboard);
$("#ingest-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = Object.fromEntries(form.entries());
  payload.estrategias = form.getAll("estrategias");
  try {
    const result = await request("/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    $("#ingest-notice").hidden = false;
    $("#ingest-notice").classList.remove("error");
    $("#ingest-notice").textContent = `Documento procesado: ${result.chunks_generados} fragmentos generados con ${result.estrategias.join(", ")}.`;
    event.currentTarget.reset();
    await loadDashboard();
    toast("Documento indexado correctamente.");
  } catch (error) {
    $("#ingest-notice").hidden = false;
    $("#ingest-notice").classList.add("error");
    $("#ingest-notice").textContent = error.message;
  }
});

async function submitSearch(mode) {
  const form = new FormData($("#search-form"));
  const payload = Object.fromEntries(form.entries());
  payload.modo = mode === "rag" ? "vector" : payload.modo;
  payload.top_k = Number(payload.top_k);
  for (const key of ["estrategia_chunking", "idioma"]) {
    if (!payload[key]) delete payload[key];
  }
  const output = $("#search-results");
  output.innerHTML = '<p class="muted">Buscando en MongoDB…</p>';
  try {
    if (mode === "rag") {
      const result = await request("/api/rag", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      output.innerHTML = `
        <article class="result-item"><strong>Respuesta generada con contexto</strong><p>${escapeHtml(result.answer)}</p></article>
        ${result.sources.map((source, index) => `<article class="result-item"><strong>Fuente ${index + 1} · score ${Number(source.score ?? 0).toFixed(3)}</strong><p>${escapeHtml(source.chunk_texto)}</p></article>`).join("")}
        <p class="muted">${escapeHtml(result.disclaimer || "")}</p>`;
    } else {
      const result = await request("/api/search", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      renderResults(result.results, output);
    }
  } catch (error) {
    output.innerHTML = `<p class="notice error">${escapeHtml(error.message)}</p>`;
  }
}

$("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  submitSearch("search");
});
$("#ask-button").addEventListener("click", () => submitSearch("rag"));

$("#image-text-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = new FormData(event.currentTarget).get("query");
  const output = $("#image-results");
  output.innerHTML = '<p class="muted">Comparando representaciones visuales…</p>';
  try {
    const result = await request("/api/images/search-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, top_k: 5 }),
    });
    renderResults(result.results, output);
  } catch (error) {
    output.innerHTML = `<p class="notice error">${escapeHtml(error.message)}</p>`;
  }
});

$("#image-file-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const output = $("#image-results");
  output.innerHTML = '<p class="muted">Buscando imágenes similares…</p>';
  try {
    const result = await request("/api/images/search", {
      method: "POST",
      body: new FormData(event.currentTarget),
    });
    renderResults(result.results, output);
  } catch (error) {
    output.innerHTML = `<p class="notice error">${escapeHtml(error.message)}</p>`;
  }
});

$("#image-upload-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const notice = $("#image-upload-notice");
  notice.hidden = false;
  notice.classList.remove("error");
  notice.textContent = "Generando embedding y guardando la imagen…";
  try {
    const result = await request("/api/images", {
      method: "POST",
      body: new FormData(event.currentTarget),
    });
    notice.textContent = `Imagen ${result.archivo} guardada en el catálogo.`;
    event.currentTarget.reset();
    await loadDashboard();
    toast("Imagen agregada al catálogo.");
  } catch (error) {
    notice.classList.add("error");
    notice.textContent = error.message;
  }
});

loadDashboard();
