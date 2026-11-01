/**
 * frontend/script.js
 *
 * Elevated browser logic for Enterprise Text-to-SQL:
 * - Particle swarm kinetics & formation transformations (sphere, table, cylinder) preserved.
 * - Dynamic ChromaDB RAG status tracking & feedback.
 * - Interactive copy-to-clipboard for SQL queries.
 * - Explicit chart axis titles and semantic currency/unit formatting.
 */
(() => {
  "use strict";

  const API_BASE = "[https://nl2sql-engine-api-hag9dsaed8g7hphw.centralindia-01.azurewebsites.net](https://nl2sql-engine-api-hag9dsaed8g7hphw.centralindia-01.azurewebsites.net)";
  const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
  const ALLOWED_EXTENSIONS = [".db", ".sqlite", ".sqlite3"];
  const SECURITY_PREFIX = "SECURITY_BLOCK:";

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const prefersReducedMotion = () =>
    !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  const show = (el) => el && el.classList.remove("hidden");
  const hide = (el) => el && el.classList.add("hidden");

  let dbPath = null;
  let pending = 0;
  let el = {};
  let currentChart = null;
  let field = null;

  function injectStyles() {
    const style = document.createElement("style");
    style.id = "t2s-injected-styles";
    style.textContent = `
:where(#orb).orb-rolling{animation:t2s-orb-roll 1.4s cubic-bezier(.45,0,.55,1) infinite alternate}
@keyframes t2s-orb-roll{from{transform:translateX(-70px) rotate(-360deg)}to{transform:translateX(70px) rotate(360deg)}}
:where(#upload-zone).is-dragover{border-color:rgba(34,211,238,0.8);background:rgba(34,211,238,0.05)}

.t2s-word{display:inline-block;white-space:nowrap}
.t2s-char{display:inline-block;opacity:0;filter:blur(6px);
  transform:translate(var(--dx,0px),var(--dy,0px)) rotate(var(--rot,0deg)) scale(.4);
  transition:transform .9s cubic-bezier(.2,.8,.2,1) var(--d,0ms),opacity .6s ease var(--d,0ms),filter .9s ease var(--d,0ms);
  will-change:transform,opacity,filter}
[data-fragment].is-joined .t2s-char{opacity:1;filter:none;transform:none}

[data-reveal]{opacity:0;transform:translateY(28px) scale(.97);filter:blur(8px);
  clip-path:polygon(-20% -20%,120% -20%,120% -20%,-20% -20%);
  transition:opacity .8s ease,transform .8s cubic-bezier(.2,.8,.2,1),filter .8s ease,clip-path .9s cubic-bezier(.2,.8,.2,1)}
[data-reveal].is-joined{opacity:1;transform:none;filter:none;clip-path:polygon(-20% -20%,120% -20%,120% 120%,-20% 120%)}

.t2s-table{border-collapse:collapse}
.t2s-row{animation:t2s-row-in .5s cubic-bezier(.2,.8,.2,1) both;animation-delay:calc(var(--i,0) * 20ms)}
@keyframes t2s-row-in{from{opacity:0;transform:translateY(12px) scale(.98);filter:blur(4px)}to{opacity:1;transform:none;filter:none}}
.t2s-pop{animation:t2s-pop .55s cubic-bezier(.34,1.56,.64,1)}
@keyframes t2s-pop{from{transform:scale(.4);opacity:0}to{transform:scale(1);opacity:1}}

@media (prefers-reduced-motion:reduce){
  .t2s-char,[data-reveal]{opacity:1!important;transform:none!important;filter:none!important;clip-path:none!important;transition:none!important}
  .t2s-row,.t2s-pop,:where(#orb).orb-rolling{animation:none!important}
}`;
    document.head.prepend(style);
  }

  function setLoading(on) {
    pending = Math.max(0, pending + (on ? 1 : -1));
    const busy = pending > 0;

    if (el.orb) el.orb.classList.toggle("orb-rolling", busy);
    document.body.classList.toggle("is-busy", busy);
    if (el.results) el.results.setAttribute("aria-busy", String(busy));
    if (el.askButton) el.askButton.disabled = busy;
    if (field) field.setEnergy(busy ? 1 : 0);
  }

  function setStatus(text) {
    if (el.status) el.status.textContent = text;
  }

  function formatDetail(detail) {
    if (!detail) return "";
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      return detail.map((d) => (d && d.msg ? d.msg : JSON.stringify(d))).join("; ");
    }
    return JSON.stringify(detail);
  }

  async function apiFetch(path, options) {
    setLoading(true);
    try {
      let res;
      try {
        res = await fetch(API_BASE + path, options);
      } catch (_) {
        throw new Error(`Cannot reach backend at ${API_BASE}. Ensure Uvicorn is active.`);
      }

      let body = null;
      try {
        body = await res.json();
      } catch (_) {}

      if (!res.ok) {
        const err = new Error(formatDetail(body && body.detail) || `Request failed (${res.status})`);
        err.status = res.status;
        throw err;
      }
      return body;
    } finally {
      setLoading(false);
    }
  }

  const STATUS_COLORS = {
    pending: "text-slate-400",
    success: "text-emerald-400",
    error: "text-rose-400",
  };

  function setUploadStatus(text, state) {
    const node = el.uploadStatus;
    if (!node) return;
    node.textContent = text;
    node.dataset.state = state;
    Object.values(STATUS_COLORS).forEach((c) => node.classList.remove(c));
    if (STATUS_COLORS[state]) node.classList.add(STATUS_COLORS[state]);
  }

  async function uploadFile(file) {
    if (!file) return;

    const name = file.name || "database.db";
    const dot = name.lastIndexOf(".");
    const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      setUploadStatus(`Unsupported file type. Use ${ALLOWED_EXTENSIONS.join(", ")}.`, "error");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadStatus(`File too large. Limit is ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`, "error");
      return;
    }

    const form = new FormData();
    form.append("file", file);

    setUploadStatus(`Indexing ${name} into ChromaDB...`, "pending");
    try {
      const data = await apiFetch("/upload", { method: "POST", body: form });
      dbPath = data.db_path;
      setUploadStatus(`${data.filename || name} indexed into Vector Store.`, "success");
    } catch (err) {
      setUploadStatus(err.message, "error");
    }
  }

  function bindUpload() {
    if (el.fileInput) {
      el.fileInput.addEventListener("change", () => {
        const file = el.fileInput.files && el.fileInput.files[0];
        uploadFile(file);
      });
    }

    const zone = el.uploadZone;
    if (!zone) return;

    ["dragenter", "dragover"].forEach((type) =>
      zone.addEventListener(type, (e) => {
        e.preventDefault();
        zone.classList.add("is-dragover");
      })
    );
    ["dragleave", "dragend", "drop"].forEach((type) =>
      zone.addEventListener(type, () => zone.classList.remove("is-dragover"))
    );
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      uploadFile(file);
    });
    zone.addEventListener("click", (e) => {
      if (e.target.closest("label, input, button, a")) return;
      if (el.fileInput) el.fileInput.click();
    });
  }

  function showError(message) {
    if (!el.errorBox) return;
    const isSecurity = message.startsWith(SECURITY_PREFIX);
    const content = el.errorContent || el.errorBox;
    content.textContent = isSecurity ? message.slice(SECURITY_PREFIX.length).trim() : message;
    show(el.errorBox);
  }

  function formatValue(value, colName) {
    if (typeof value !== "number") return value;

    const isFinancial = /revenue|price|total|cost|amount|sales|fee/i.test(colName || "");
    if (isFinancial) {
      return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
    }

    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
  }

  function renderCell(td, value, colName) {
    if (value === null || value === undefined) {
      const span = document.createElement("span");
      span.className = "italic text-slate-600 font-mono text-xs";
      span.textContent = "NULL";
      td.appendChild(span);
      return;
    }

    const formatted = formatValue(value, colName);
    const text = typeof formatted === "object" ? JSON.stringify(formatted) : String(formatted);

    td.textContent = text;
    if (text.length > 40) td.title = text;
    if (typeof value === "number") td.classList.add("text-right", "tabular-nums");
  }

  function renderTable(columns, rows) {
    if (!el.tableWrap) return;
    el.tableWrap.replaceChildren();

    if (!rows.length) {
      const p = document.createElement("p");
      p.className = "text-slate-400 text-sm font-mono py-2";
      p.textContent = "Query executed successfully, but returned 0 rows.";
      el.tableWrap.appendChild(p);
      return;
    }

    const cols = columns && columns.length ? columns : Object.keys(rows[0]);

    const scroller = document.createElement("div");
    scroller.className = "overflow-x-auto rounded-xl border border-white/10 bg-black/40";

    const table = document.createElement("table");
    table.className = "t2s-table min-w-full text-sm";

    const thead = table.createTHead();
    const headRow = thead.insertRow();
    cols.forEach((col) => {
      const th = document.createElement("th");
      th.scope = "col";
      th.className =
        "bg-white/[0.04] px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-slate-300 whitespace-nowrap border-b border-white/10";
      th.textContent = col;
      headRow.appendChild(th);
    });

    const tbody = table.createTBody();
    rows.forEach((row, i) => {
      const tr = tbody.insertRow();
      tr.className = "t2s-row hover:bg-white/[0.02] transition-colors";
      tr.style.setProperty("--i", String(Math.min(i, 40)));
      cols.forEach((col) => {
        const td = tr.insertCell();
        td.className =
          "max-w-xs truncate whitespace-nowrap border-t border-white/5 px-4 py-2.5 text-slate-300 font-mono text-xs";
        renderCell(td, row[col], col);
      });
    });

    scroller.appendChild(table);
    el.tableWrap.appendChild(scroller);
  }

  function renderChart(config, rows) {
    const canvas = $("analytics-chart");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (currentChart) currentChart.destroy();

    const labels = rows.map((r) => r[config.x]);
    const values = rows.map((r) => r[config.y]);

    const isFinancial = /revenue|price|total|cost|amount|sales|fee/i.test(config.y || "");
    const formatTick = (val) =>
      isFinancial
        ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(val)
        : new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(val);

    const gradientCyan = ctx.createLinearGradient(0, 0, 0, 400);
    gradientCyan.addColorStop(0, "rgba(34, 211, 238, 0.85)");
    gradientCyan.addColorStop(1, "rgba(34, 211, 238, 0.05)");

    const gradientPurple = ctx.createLinearGradient(0, 0, 0, 400);
    gradientPurple.addColorStop(0, "rgba(168, 85, 247, 0.85)");
    gradientPurple.addColorStop(1, "rgba(168, 85, 247, 0.05)");

    const gradientPink = ctx.createLinearGradient(0, 0, 0, 400);
    gradientPink.addColorStop(0, "rgba(236, 72, 153, 0.85)");
    gradientPink.addColorStop(1, "rgba(236, 72, 153, 0.05)");

    const doughnutColors = [
      gradientCyan,
      gradientPurple,
      gradientPink,
      "rgba(59, 130, 246, 0.8)",
      "rgba(16, 185, 129, 0.8)",
    ];

    const glowPlugin = {
      id: "glow",
      beforeDraw: (chart) => {
        const renderCtx = chart.ctx;
        renderCtx.save();
        renderCtx.shadowColor =
          config.type === "doughnut" ? "rgba(0, 0, 0, 0.5)" : "rgba(34, 211, 238, 0.4)";
        renderCtx.shadowBlur = 20;
        renderCtx.shadowOffsetX = 0;
        renderCtx.shadowOffsetY = 8;
      },
      afterDraw: (chart) => {
        chart.ctx.restore();
      },
    };

    currentChart = new Chart(ctx, {
      type: config.type,
      data: {
        labels: labels,
        datasets: [
          {
            label: config.y,
            data: values,
            backgroundColor: config.type === "doughnut" ? doughnutColors : gradientCyan,
            borderColor: config.type === "doughnut" ? "rgba(3, 7, 18, 0.8)" : "rgba(34, 211, 238, 1)",
            borderWidth: config.type === "doughnut" ? 4 : 2,
            borderRadius: config.type === "bar" ? 6 : 0,
            tension: 0.4,
            fill: true,
            pointBackgroundColor: "#030712",
            pointBorderColor: "rgba(34, 211, 238, 1)",
            pointBorderWidth: 2,
            pointRadius: 4,
            pointHoverRadius: 8,
            pointHoverBackgroundColor: "rgba(34, 211, 238, 1)",
            pointHoverBorderColor: "#fff",
            hoverOffset: 18,
          },
        ],
      },
      plugins: [glowPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: {
          duration: 1600,
          easing: "easeOutQuart",
          delay: (context) => context.dataIndex * 80,
        },
        interaction: {
          mode: "index",
          intersect: false,
        },
        plugins: {
          legend: {
            display: config.type === "doughnut",
            position: "right",
            labels: {
              color: "#cbd5e1",
              usePointStyle: true,
              padding: 25,
              font: { family: "ui-monospace, monospace" },
            },
          },
          tooltip: {
            backgroundColor: "rgba(3, 7, 18, 0.85)",
            titleColor: "#e2e8f0",
            bodyColor: "#22d3ee",
            borderColor: "rgba(255, 255, 255, 0.1)",
            borderWidth: 1,
            padding: 14,
            boxPadding: 6,
            usePointStyle: true,
            titleFont: { size: 12, family: "ui-monospace, monospace" },
            bodyFont: { size: 14, weight: "bold", family: "ui-monospace, monospace" },
            cornerRadius: 8,
            callbacks: {
              label: function (context) {
                let label = context.dataset.label || "";
                if (label) {
                  label += ": ";
                }
                if (config.type === "doughnut") {
                  label += formatTick(context.raw);
                } else if (context.parsed.y !== null) {
                  label += formatTick(context.parsed.y);
                }
                return label;
              },
            },
          },
        },
        scales:
          config.type !== "doughnut"
            ? {
                x: {
                  title: {
                    display: true,
                    text: String(config.x).toUpperCase(),
                    color: "#94a3b8",
                    font: { family: "ui-monospace, monospace", size: 11, weight: "bold" },
                  },
                  ticks: { color: "#64748b", font: { family: "ui-monospace, monospace" } },
                  grid: { color: "rgba(255,255,255,0)", drawBorder: false },
                },
                y: {
                  beginAtZero: true,
                  title: {
                    display: true,
                    text: String(config.y).toUpperCase(),
                    color: "#94a3b8",
                    font: { family: "ui-monospace, monospace", size: 11, weight: "bold" },
                  },
                  ticks: {
                    color: "#64748b",
                    font: { family: "ui-monospace, monospace" },
                    callback: function (value) {
                      return formatTick(value);
                    },
                  },
                  grid: {
                    color: "rgba(255,255,255,0.05)",
                    drawBorder: false,
                    borderDash: [6, 6],
                  },
                },
              }
            : {},
      },
    });
  }

  function popIn(node) {
    if (!node) return;
    node.classList.remove("t2s-pop");
    void node.offsetWidth;
    node.classList.add("t2s-pop");
  }

  function renderResults(data, seconds) {
    show(el.results);
    hide(el.errorBox);

    if (el.sqlOutput) el.sqlOutput.textContent = data.sql_query || "-- No query generated";

    const retries = Number.isFinite(data.retries) ? data.retries : 0;
    if (el.retries) {
      el.retries.textContent = String(retries);
      popIn(el.retries);
    }

    const rows = Array.isArray(data.data) ? data.data : [];
    if (el.rowCount) {
      const n = Number.isFinite(data.row_count) ? data.row_count : rows.length;
      el.rowCount.textContent = `${n} row${n === 1 ? "" : "s"}`;
      popIn(el.rowCount);
    }

    if (data.success === false) {
      if (el.tableWrap) el.tableWrap.replaceChildren();
      hide($("chart-container"));
      showError(data.error || "The agents could not produce a working query.");
      setStatus(`Failed after ${retries} retr${retries === 1 ? "y" : "ies"}`);
    } else {
      renderTable(data.columns, rows);

      if (data.chart_config && rows.length > 0) {
        show($("chart-container"));
        renderChart(data.chart_config, rows);
      } else {
        hide($("chart-container"));
      }

      setStatus(`Execution complete in ${seconds.toFixed(2)}s`);
    }

    observeScrollEffects(el.results);
    if (el.results && el.results.scrollIntoView) {
      el.results.scrollIntoView({
        behavior: prefersReducedMotion() ? "auto" : "smooth",
        block: "start",
      });
    }
  }

  async function runQuery(question) {
    hide(el.errorBox);
    setStatus("Pruning schema via ChromaDB & generating SQL...");
    const started = performance.now();

    try {
      const data = await apiFetch("/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, db_path: dbPath }),
      });
      renderResults(data, (performance.now() - started) / 1000);
    } catch (err) {
      if (err.status === 404 && dbPath) {
        dbPath = null;
        setUploadStatus("Uploaded database session expired.", "error");
      }
      show(el.results);
      if (el.tableWrap) el.tableWrap.replaceChildren();
      showError(err.message);
      setStatus("Pipeline execution failed");
    }
  }

  function bindCopy() {
    if (!el.copyBtn) return;
    el.copyBtn.addEventListener("click", () => {
      const sql = el.sqlOutput ? el.sqlOutput.textContent : "";
      if (!sql || sql.startsWith("--")) return;
      navigator.clipboard.writeText(sql).then(() => {
        if (el.copyText) el.copyText.textContent = "Copied!";
        setTimeout(() => {
          if (el.copyText) el.copyText.textContent = "Copy";
        }, 1800);
      });
    });
  }

  function bindQuery() {
    if (!el.form) return;
    el.form.addEventListener("submit", (e) => {
      e.preventDefault();
      const question = el.questionInput ? el.questionInput.value.trim() : "";
      if (!question || pending > 0) return;
      runQuery(question);
    });
  }

  // ------------------------------------------------------------------------ //
  // Preserved Particle Field Kinetics
  // ------------------------------------------------------------------------ //

  const GOLDEN_ANGLE = Math.PI * (1 + Math.sqrt(5));

  function formationSphere(i, n, _t, rotY, out) {
    const k = i + 0.5;
    const phi = Math.acos(1 - (2 * k) / n);
    const theta = GOLDEN_ANGLE * k + rotY;
    out[0] = Math.cos(theta) * Math.sin(phi);
    out[1] = Math.cos(phi);
    out[2] = Math.sin(theta) * Math.sin(phi);
  }

  function formationTable(i, n, t, _rotY, out) {
    const cols = Math.ceil(Math.sqrt(n * 1.7));
    const rows = Math.ceil(n / cols);
    const c = i % cols;
    const r = Math.floor(i / cols);
    out[0] = (c / Math.max(1, cols - 1) - 0.5) * 2.6;
    out[1] = (r / Math.max(1, rows - 1) - 0.5) * 1.7;
    out[2] = Math.sin(c * 0.55 + r * 0.35 + t * 0.0016) * 0.18;
  }

  function formationCylinder(i, n, _t, rotY, out) {
    const layers = 5;
    const per = Math.ceil(n / layers);
    const layer = Math.min(layers - 1, Math.floor(i / per));
    const a = ((i % per) / per) * Math.PI * 2 + rotY;
    out[0] = Math.cos(a) * 0.8;
    out[1] = (layer / (layers - 1) - 0.5) * 1.7;
    out[2] = Math.sin(a) * 0.8;
  }

  const FORMATIONS = [formationSphere, formationTable, formationCylinder, formationSphere];

  function initParticleField() {
    const canvas = document.createElement("canvas");
    canvas.id = "particle-field";
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.cssText =
      "position:fixed;inset:0;width:100%;height:100%;z-index:-1;pointer-events:none;";
    document.body.prepend(canvas);

    const ctx = canvas.getContext ? canvas.getContext("2d") : null;
    if (!ctx) {
      canvas.remove();
      return null;
    }

    const reduced = prefersReducedMotion();
    const rootStyle = getComputedStyle(document.documentElement);
    const hueA = parseFloat(rootStyle.getPropertyValue("--particle-hue-a")) || 265;
    const hueB = parseFloat(rootStyle.getPropertyValue("--particle-hue-b")) || 190;

    const compact = Math.min(window.innerWidth, window.innerHeight) < 640;
    const N = compact ? 240 : 460;

    const delay = new Float32Array(N);
    const burst = new Float32Array(N * 3);
    const spin = new Float32Array(N);
    const size = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      delay[i] = Math.random();
      burst[i * 3] = (Math.random() - 0.5) * 2.6;
      burst[i * 3 + 1] = (Math.random() - 0.5) * 2.6;
      burst[i * 3 + 2] = (Math.random() - 0.5) * 2.0;
      spin[i] = Math.random() * Math.PI * 2;
      size[i] = 0.6 + Math.random() * 0.9;
    }

    let w = 0,
      h = 0,
      R = 0,
      progress = 0,
      targetProgress = 0,
      energy = 0,
      targetEnergy = 0;
    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    const A = [0, 0, 0];
    const B = [0, 0, 0];

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      R = Math.min(w, h) * 0.34;
    }

    function readScroll() {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      targetProgress = max > 0 ? clamp(window.scrollY / max, 0, 1) : 0;
    }

    function draw(time) {
      const last = FORMATIONS.length - 1;
      const seg = progress * last;
      const idx = Math.min(last - 1, Math.floor(seg));
      const local = seg - idx;
      const fromF = FORMATIONS[idx];
      const toF = FORMATIONS[idx + 1];

      const rotY = reduced ? 0.6 : time * 0.00025 * (1 + energy * 3) + pointer.x * 1.2;
      const tilt = 0.35 + pointer.y * 0.4;
      const cosT = Math.cos(tilt);
      const sinT = Math.sin(tilt);
      const burstAmp = 0.9 + energy * 0.9;
      const cx = w / 2 + pointer.x * 24;
      const cy = h / 2 + pointer.y * 18;
      const baseSize = compact ? 2.2 : 2.9;

      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";

      for (let i = 0; i < N; i++) {
        fromF(i, N, time, rotY, A);
        toF(i, N, time, rotY, B);

        const raw = clamp(local * 1.7 - delay[i] * 0.7, 0, 1);
        const tt = easeInOutCubic(raw);
        const frag = Math.sin(Math.PI * tt) * burstAmp;

        let x = A[0] + (B[0] - A[0]) * tt + burst[i * 3] * frag;
        let y = A[1] + (B[1] - A[1]) * tt + burst[i * 3 + 1] * frag;
        let z = A[2] + (B[2] - A[2]) * tt + burst[i * 3 + 2] * frag;

        if (energy > 0.01 && !reduced) {
          x += Math.sin(time * 0.004 + i) * 0.03 * energy;
          y += Math.cos(time * 0.0035 + i * 1.7) * 0.03 * energy;
        }

        const y2 = y * cosT - z * sinT;
        const z2 = y * sinT + z * cosT;
        const scale = 3 / (3 - clamp(z2, -1.8, 1.8));
        const sx = cx + x * R * scale;
        const sy = cy + y2 * R * scale;

        const depth = clamp((z2 + 1.4) / 2.8, 0, 1);
        const alpha = 0.18 + depth * 0.5 + frag * 0.12;
        const hue = hueA + (hueB - hueA) * clamp((y + 1) / 2, 0, 1);
        const r = baseSize * size[i] * scale;
        const a = spin[i] + (reduced ? 0 : time * 0.0006) + frag * 3;

        ctx.fillStyle = `hsla(${hue.toFixed(0)},85%,${(58 + depth * 14).toFixed(0)}%,${alpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(sx + Math.cos(a) * r * 1.7, sy + Math.sin(a) * r * 1.7);
        ctx.lineTo(sx + Math.cos(a + 2.4) * r, sy + Math.sin(a + 2.4) * r);
        ctx.lineTo(sx + Math.cos(a - 2.4) * r, sy + Math.sin(a - 2.4) * r);
        ctx.closePath();
        ctx.fill();
      }
    }

    let lastTime = performance.now();
    function frame(now) {
      const dt = Math.min(64, now - lastTime);
      lastTime = now;

      readScroll();
      const ease = 1 - Math.exp(-dt / 160);
      progress += (targetProgress - progress) * ease;
      energy += (targetEnergy - energy) * (1 - Math.exp(-dt / 260));
      pointer.x += (pointer.tx - pointer.x) * ease;
      pointer.y += (pointer.ty - pointer.y) * ease;

      document.documentElement.style.setProperty("--scroll-progress", progress.toFixed(4));
      draw(now);
      requestAnimationFrame(frame);
    }

    resize();
    window.addEventListener("resize", () => {
      resize();
      if (reduced) {
        readScroll();
        progress = targetProgress;
        draw(0);
      }
    });

    if (reduced) {
      let queued = false;
      const redraw = () => {
        queued = false;
        readScroll();
        progress = targetProgress;
        draw(0);
      };
      window.addEventListener(
        "scroll",
        () => {
          if (!queued) {
            queued = true;
            requestAnimationFrame(redraw);
          }
        },
        { passive: true }
      );
      redraw();
    } else {
      window.addEventListener(
        "pointermove",
        (e) => {
          pointer.tx = e.clientX / Math.max(1, w) - 0.5;
          pointer.ty = e.clientY / Math.max(1, h) - 0.5;
        },
        { passive: true }
      );
      readScroll();
      progress = targetProgress;
      requestAnimationFrame(frame);
    }

    return {
      setEnergy(v) {
        targetEnergy = clamp(v, 0, 1);
      },
    };
  }

  function splitIntoFragments(node) {
    if (node.dataset.fragmentReady) return;
    const text = node.textContent.replace(/\s+/g, " ").trim();
    if (!text) return;

    node.dataset.fragmentReady = "1";
    node.setAttribute("aria-label", text);
    node.replaceChildren();

    let charIndex = 0;
    text.split(" ").forEach((word, wi, words) => {
      const wordSpan = document.createElement("span");
      wordSpan.className = "t2s-word";
      wordSpan.setAttribute("aria-hidden", "true");

      for (const ch of Array.from(word)) {
        const c = document.createElement("span");
        c.className = "t2s-char";
        c.textContent = ch;
        c.style.setProperty("--dx", `${Math.round((Math.random() - 0.5) * 260)}px`);
        c.style.setProperty("--dy", `${Math.round((Math.random() - 0.5) * 180)}px`);
        c.style.setProperty("--rot", `${Math.round((Math.random() - 0.5) * 220)}deg`);
        c.style.setProperty(
          "--d",
          `${Math.round(Math.min(charIndex, 40) * 16 + Math.random() * 140)}ms`
        );
        wordSpan.appendChild(c);
        charIndex++;
      }
      node.appendChild(wordSpan);
      if (wi < words.length - 1) node.appendChild(document.createTextNode(" "));
    });
  }

  let scrollObserver = null;

  function getScrollObserver() {
    if (scrollObserver || !("IntersectionObserver" in window)) return scrollObserver;
    scrollObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const node = entry.target;
          if (entry.isIntersecting) {
            node.classList.add("is-joined");
            if (node.hasAttribute("data-reveal")) scrollObserver.unobserve(node);
          } else if (node.hasAttribute("data-fragment")) {
            node.classList.remove("is-joined");
          }
        }
      },
      { threshold: 0, rootMargin: "0px 0px -12% 0px" }
    );
    return scrollObserver;
  }

  function observeScrollEffects(root) {
    const scope = root || document;
    const nodes = scope.querySelectorAll("[data-fragment], [data-reveal]");
    nodes.forEach((node) => {
      if (node.hasAttribute("data-fragment")) splitIntoFragments(node);
      if (node.dataset.t2sObserved) return;
      node.dataset.t2sObserved = "1";

      const observer = getScrollObserver();
      if (!observer || prefersReducedMotion()) {
        node.classList.add("is-joined");
      } else {
        observer.observe(node);
      }
    });
  }

  function init() {
    el = {
      fileInput: $("db-file"),
      uploadZone: $("upload-zone"),
      uploadStatus: $("upload-status"),
      form: $("question-form"),
      questionInput: $("question-input"),
      askButton: document.querySelector("#question-form [type='submit']"),
      orb: $("orb"),
      status: $("status"),
      results: $("results"),
      sqlOutput: $("sql-output"),
      retries: $("retries"),
      rowCount: $("row-count"),
      tableWrap: $("table-wrap"),
      errorBox: $("error-box"),
      errorContent: $("error-content"),
      copyBtn: $("copy-sql-btn"),
      copyText: $("copy-text"),
    };

    injectStyles();
    bindUpload();
    bindQuery();
    bindCopy();
    observeScrollEffects(document);
    field = initParticleField();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();