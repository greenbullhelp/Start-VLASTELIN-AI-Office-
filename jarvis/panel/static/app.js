// Джарвіс — приватна панель. Без збірки й зовнішніх бібліотек: звичайний ES-модуль.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (v, d = 2) => "$" + Number(v || 0).toFixed(d);
const fmtTime = (ts) => { const d = new Date(ts * 1000); return d.toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); };
const store = { get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватний режим */ } } };

const VIEWS = [
  ["chat", "Чат", "◎"], ["tasks", "Задачі", "☰"], ["projects", "Проєкти", "▤"], ["market", "Ринок", "◆"],
  ["game", "Гра та бізнес", "♠"], ["ideas", "Ідеї", "✦"], ["agents", "Агенти", "⌬"], ["reports", "Звіти", "▦"], ["settings", "Налаштування", "⚙"],
];
const STATUS = { queued: "у черзі", waiting: "чекає", running: "працює", review: "на перевірці", review_running: "перевіряє Контролер",
  delegated: "роздано агентам", done: "готово", failed: "помилка", stopped: "зупинено", needs_owner: "потрібне рішення", cancelled: "скасовано" };
const AGENT_NAMES = { jarvis: "Джарвіс", controller: "Контролер", game: "Ігровий", video: "Відео", trading: "Трейдинг", research: "Дослідник" };

let S = { view: "chat", state: null, msgs: [], lastId: 0, busy: false };

// ---------- API ----------
async function api(path, opts = {}) {
  const o = { method: opts.method || "GET", headers: { "X-Jarvis": "1" }, credentials: "same-origin" };
  if (opts.body instanceof FormData) o.body = opts.body;
  else if (opts.body !== undefined) { o.body = JSON.stringify(opts.body); o.headers["Content-Type"] = "application/json"; }
  const r = await fetch(path, o);
  if (r.status === 401 && !path.startsWith("/api/login") && !path.startsWith("/api/2fa")) { showLogin(); throw new Error("auth"); }
  let data = null;
  try { data = await r.json(); } catch { /* без тіла */ }
  if (!r.ok && !(data && (data.enroll || data.error))) throw new Error((data && (data.detail || data.error)) || `HTTP ${r.status}`);
  return data;
}
function toast(text, ms = 3200) {
  const d = document.createElement("div"); d.textContent = text; $("#toast").append(d); setTimeout(() => d.remove(), ms);
}
async function act(fn, okText) {
  try { const r = await fn(); if (okText) toast(okText); return r; } catch (e) { if (e.message !== "auth") toast("⚠ " + e.message, 5000); }
}

// ---------- вхід ----------
let enrollToken = "";
function showLogin() { $("#app").hidden = true; $("#login").hidden = false; $("#loginForm").hidden = false; $("#enrollForm").hidden = true; }
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault(); $("#loginErr").textContent = "";
  try {
    const r = await api("/api/login", { method: "POST", body: { password: $("#pw").value, code: $("#code").value } });
    if (r.enroll) {
      enrollToken = r.enroll_token; $("#qr").innerHTML = r.qr; $("#otpLink").href = r.otpauth; $("#secret").textContent = "Ключ: " + r.secret;
      $("#loginForm").hidden = true; $("#enrollForm").hidden = false; $("#ecode").focus();
    } else if (r.ok) boot(); else $("#loginErr").textContent = r.error || "Помилка входу";
  } catch (err) { $("#loginErr").textContent = err.message; }
});
$("#enrollForm").addEventListener("submit", async (e) => {
  e.preventDefault(); $("#enrollErr").textContent = "";
  try {
    const r = await api("/api/2fa/enroll", { method: "POST", body: { enroll_token: enrollToken, code: $("#ecode").value } });
    if (r.ok) boot(); else $("#enrollErr").textContent = r.error;
  } catch (err) { $("#enrollErr").textContent = err.message; }
});

// ---------- навігація ----------
function buildNav() {
  $("#nav").innerHTML = VIEWS.map(([k, t]) => `<button data-v="${k}">${t}${k === "tasks" ? '<span class="badge" data-badge hidden></span>' : ""}</button>`).join("");
  $("#tabbar").innerHTML = VIEWS.map(([k, t, i]) => `<button data-v="${k}"><span>${i}</span>${t.split(" ")[0]}${k === "tasks" ? '<span class="badge" data-badge hidden></span>' : ""}</button>`).join("");
  $$("[data-v]").forEach((b) => b.addEventListener("click", () => go(b.dataset.v)));
}
function go(v) {
  S.view = v; store.set("view", v); location.hash = v;
  $$("[data-v]").forEach((b) => b.classList.toggle("active", b.dataset.v === v));
  document.body.className = "v-" + v;
  render();
  if (v === "chat") scrollChat();
}
window.addEventListener("hashchange", () => { const v = location.hash.slice(1); if (v && v !== S.view && VIEWS.some((x) => x[0] === v)) go(v); });

// ---------- стан ----------
async function loadState() {
  try { S.state = await api("/api/state"); } catch { return; }
  const st = S.state;
  const pill = (el, ok, text) => { el.innerHTML = `<span class="dot ${ok === null ? "" : ok ? "on" : "off"}"></span>${text}`; };
  pill($("#pBrain"), st.brain.ok, st.brain.name === "hermes" ? "Hermes" : st.brain.name === "anthropic" ? "Claude API" : "Тест");
  $("#pBrain").title = st.brain.detail;
  pill($("#pNode"), st.node && st.node.online !== undefined ? st.node.online : null, "ПК");
  const ratio = st.limit ? st.spent / st.limit : 0;
  $("#pSpend").innerHTML = `<span class="dot ${ratio > .9 ? "off" : ratio > .7 ? "wait" : "on"}"></span>${money(st.spent)} / ${money(st.limit, 0)}`;
  const stop = $("#stopBtn");
  stop.textContent = st.halted ? "ПРОДОВЖИТИ" : "СТОП"; stop.classList.toggle("resume", st.halted);
  $$("[data-badge]").forEach((b) => { b.hidden = !st.approvals; b.textContent = st.approvals; });
  $("#orb").classList.toggle("thinking", st.running > 0 && !speaking);
}
$("#stopBtn").addEventListener("click", async () => {
  if (S.state && S.state.halted) { await act(() => api("/api/resume", { method: "POST" }), "▶ Роботу відновлено"); }
  else { await act(() => api("/api/stop", { method: "POST" }), "⏹ Усіх агентів зупинено"); }
  loadState(); render();
});

// ---------- живі оновлення (SSE) ----------
let es, refreshTimer;
function connectStream() {
  if (es) es.close();
  es = new EventSource("/api/stream");
  es.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === "message") loadMessages(true);
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { loadState(); if (S.view !== "chat" || window.innerWidth > 860) renderSoft(m.type); }, 350);
  };
  es.onerror = () => { es.close(); setTimeout(connectStream, 4000); };
}
const SOFT = { tasks: ["task", "approvals", "audit"], chat: ["task", "approvals", "costs", "halted"], agents: ["task", "agents", "halted", "node"],
  projects: ["projects"], ideas: ["ideas"], reports: ["reports", "costs"], market: ["market"], game: ["game", "node"] };
function renderSoft(type) { if ((SOFT[S.view] || []).includes(type)) render(true); }

// ---------- чат ----------
async function loadMessages(onlyNew = false) {
  const rows = await api("/api/messages?limit=80").catch(() => null);
  if (!rows) return;
  const fresh = rows.filter((m) => m.id > S.lastId);
  if (onlyNew && !fresh.length) return;
  S.msgs = rows; const prevLast = S.lastId; S.lastId = rows.length ? rows[rows.length - 1].id : 0;
  renderMessages();
  if (prevLast && store.get("tts", true) && S.state?.settings?.tts !== false) fresh.filter((m) => m.role === "jarvis").forEach((m) => speak(m.text));
}
function waveHtml(meta) {
  const peaks = meta.peaks && meta.peaks.length ? meta.peaks : Array.from({ length: 40 }, () => .3);
  const bars = peaks.slice(0, 60).map((p) => `<i style="height:${Math.max(3, Math.round(p * 26))}px"></i>`).join("");
  return `<div class="wave"><button class="play" data-audio="${esc(meta.voice)}" aria-label="Відтворити">▶</button><div class="bars">${bars}</div><span class="dim">${meta.duration ? meta.duration + " с" : ""}</span></div>`;
}
function renderMessages() {
  const box = $("#msgs");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.innerHTML = S.msgs.map((m) => {
    const meta = m.meta || {};
    const info = [];
    if (m.source === "telegram") info.push('<span class="src">Telegram</span>');
    if (meta.model) info.push(esc(meta.model));
    if (meta.cost !== undefined && m.role === "jarvis") info.push(money(meta.cost, 4));
    if (meta.note) info.push(esc(meta.note));
    info.push(fmtTime(m.ts));
    return `<div class="msg ${m.role === "owner" ? "owner" : "jarvis"} ${meta.report ? "report" : ""}">${meta.voice ? waveHtml(meta) : ""}${esc(m.text)}<div class="meta">${info.join(" · ")}</div></div>`;
  }).join("") + (S.state && S.state.running ? '<div class="typing">Джарвіс працює <i></i><i></i><i></i></div>' : "");
  if (atBottom) scrollChat();
}
function scrollChat() { const b = $("#msgs"); b.scrollTop = b.scrollHeight; }
$("#msgs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-audio]"); if (!b) return;
  const a = new Audio("/api/voice/" + encodeURIComponent(b.dataset.audio)); b.textContent = "❚❚"; a.onended = () => (b.textContent = "▶"); a.play().catch(() => (b.textContent = "▶"));
});
const input = $("#input");
input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 160) + "px"; });
input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && window.innerWidth > 860) { e.preventDefault(); $("#composer").requestSubmit(); } });
$("#composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim(); if (!text) return;
  input.value = ""; input.style.height = "auto";
  await act(() => api("/api/chat", { method: "POST", body: { text, model: $("#modelSel").value } }));
  loadMessages(true); loadState();
});

// ---------- голос: запис із хвилею ----------
let rec = null;
$("#micBtn").addEventListener("click", () => (rec ? stopRec(true) : startRec()));
$("#recCancel").addEventListener("click", () => stopRec(false));
async function startRec() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { toast("Цей браузер не підтримує запис голосу"); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch { toast("Немає доступу до мікрофона"); return; }
  stopSpeaking();
  const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((t) => MediaRecorder.isTypeSupported(t)) || "";
  const mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(stream); const an = ctx.createAnalyser(); an.fftSize = 1024; src.connect(an);
  rec = { mr, stream, ctx, an, chunks: [], peaks: [], start: Date.now(), transcript: "", send: true, type: mr.mimeType || type };
  mr.ondataavailable = (ev) => ev.data.size && rec.chunks.push(ev.data);
  mr.onstop = finishRec;
  mr.start(250);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR) {
    try {
      const sr = new SR(); sr.lang = "uk-UA"; sr.continuous = true; sr.interimResults = true;
      sr.onresult = (ev) => { let fin = "", tmp = ""; for (const r of ev.results) (r.isFinal ? (fin += r[0].transcript + " ") : (tmp += r[0].transcript)); rec && (rec.transcript = fin.trim(), $("#liveText").textContent = (fin + tmp).trim()); };
      sr.onerror = () => {}; sr.start(); rec.sr = sr;
    } catch { /* сервер розпізнає сам */ }
  }
  $("#recbar").hidden = false; $("#micBtn").classList.add("rec"); $("#micBtn").textContent = "■"; $("#liveText").textContent = "Говоріть…";
  drawWave();
}
function drawWave() {
  if (!rec) return;
  const cv = $("#wave"), g = cv.getContext("2d"), dpr = window.devicePixelRatio || 1;
  cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr;
  const buf = new Uint8Array(rec.an.fftSize); rec.an.getByteTimeDomainData(buf);
  let sum = 0; for (const v of buf) sum += ((v - 128) / 128) ** 2;
  const rms = Math.min(1, Math.sqrt(sum / buf.length) * 3.2);
  const t = Date.now(); if (!rec.lastPeak || t - rec.lastPeak > 100) { rec.peaks.push(+rms.toFixed(3)); rec.lastPeak = t; }
  g.clearRect(0, 0, cv.width, cv.height);
  const n = Math.floor(cv.width / (5 * dpr)), last = rec.peaks.slice(-n);
  g.fillStyle = "rgba(120,210,255,.9)"; g.shadowColor = "rgba(76,194,255,.8)"; g.shadowBlur = 6 * dpr;
  last.forEach((p, i) => { const h = Math.max(2 * dpr, p * cv.height * .9); g.fillRect(i * 5 * dpr, (cv.height - h) / 2, 3 * dpr, h); });
  requestAnimationFrame(drawWave);
}
function stopRec(send) {
  if (!rec) return; rec.send = send;
  try { rec.sr && rec.sr.stop(); } catch { /* */ }
  rec.mr.state !== "inactive" ? rec.mr.stop() : finishRec();
}
async function finishRec() {
  const r = rec; rec = null; if (!r) return;
  r.stream.getTracks().forEach((t) => t.stop()); r.ctx.close().catch(() => {});
  $("#recbar").hidden = true; $("#micBtn").classList.remove("rec"); $("#micBtn").textContent = "🎤";
  if (!r.send || !r.chunks.length) return;
  const dur = (Date.now() - r.start) / 1000; if (dur < .6) { toast("Занадто коротке голосове"); return; }
  const blob = new Blob(r.chunks, { type: r.type || "audio/webm" });
  const fd = new FormData();
  fd.append("audio", blob, r.type.includes("mp4") ? "voice.mp4" : "voice.webm");
  fd.append("transcript", r.transcript || ""); fd.append("duration", dur.toFixed(1));
  const step = Math.max(1, Math.ceil(r.peaks.length / 60)); const pk = [];
  for (let i = 0; i < r.peaks.length; i += step) pk.push(Math.max(...r.peaks.slice(i, i + step)));
  fd.append("peaks", JSON.stringify(pk)); fd.append("model", $("#modelSel").value);
  toast("Надсилаю голосове…", 1500);
  await act(() => api("/api/voice", { method: "POST", body: fd }));
  loadMessages(true); loadState();
}

// ---------- голос Джарвіса (озвучення) ----------
let speaking = false;
function pickVoice() {
  const vs = speechSynthesis.getVoices(); const want = store.get("voiceName", "") || S.state?.settings?.voice_name;
  return vs.find((v) => v.name === want) || vs.find((v) => /^uk/i.test(v.lang)) || null;
}
function speak(text) {
  if (!("speechSynthesis" in window)) return;
  const clean = String(text).replace(/[•✅❌⚠⏹✖◆▶⏸⛔📋💰]/g, "").slice(0, 600); if (!clean.trim()) return;
  const u = new SpeechSynthesisUtterance(clean); const v = pickVoice(); if (v) u.voice = v; u.lang = v ? v.lang : "uk-UA"; u.rate = 1.03;
  u.onstart = () => { speaking = true; $("#orb").classList.add("speaking"); };
  u.onend = u.onerror = () => { speaking = false; $("#orb").classList.remove("speaking"); };
  speechSynthesis.speak(u);
}
function stopSpeaking() { try { speechSynthesis.cancel(); } catch { /* */ } speaking = false; $("#orb").classList.remove("speaking"); }

// ---------- рендер розділів ----------
const card = (title, body, extra = "", cls = "") => `<section class="card ${cls}"><div class="head"><h3>${title}</h3>${extra}</div><div class="body">${body}</div></section>`;
const tag = (st) => `<span class="tag ${st}">${STATUS[st] || st}</span>`;
const bar = (p, cls = "") => `<div class="bar ${cls}"><i style="width:${Math.max(0, Math.min(100, p))}%"></i></div>`;
const empty = (t) => `<div class="empty">${t}</div>`;

async function render(soft = false) {
  const v = S.view, el = $("#view");
  if (v === "chat" && window.innerWidth <= 860) { renderMessages(); return; }
  try {
    const html = await (R[v] || R.chat)();
    if (S.view !== v) return;
    const y = el.scrollTop; el.innerHTML = html; if (soft) el.scrollTop = y;
    (A[v] || (() => {}))();
  } catch (e) { if (e.message !== "auth") el.innerHTML = card("Помилка", esc(e.message)); }
}

function approvalsHtml(list) {
  if (!list.length) return empty("Немає запитів — усе під контролем.");
  return `<div class="list">${list.map((a) => `<div class="item approval"><div class="row between"><div class="t">#${a.id} ${esc(a.title)}</div><span class="tag">${esc(a.action)}</span></div>
    <div class="m">${esc(a.requested_by)} · ${fmtTime(a.ts)}</div>${a.details ? `<pre>${esc(a.details)}</pre>` : ""}
    <div class="row" style="margin-top:8px"><button class="btn sm primary" data-appr="${a.id}" data-ok="1">Дозволити</button><button class="btn sm danger" data-appr="${a.id}" data-ok="0">Відхилити</button></div></div>`).join("")}</div>`;
}
function bindApprovals() {
  $$("[data-appr]").forEach((b) => b.addEventListener("click", async () => {
    const ok = b.dataset.ok === "1"; const note = ok ? "" : (prompt("Коментар (необов'язково):") || "");
    const r = await act(() => api(`/api/approvals/${b.dataset.appr}`, { method: "POST", body: { approve: ok, note } }));
    if (r) toast(`${ok ? "Схвалено" : "Відхилено"}: ${r.result}`); render(true); loadState();
  }));
}
function taskItem(t, open = false) {
  const name = AGENT_NAMES[t.agent] || t.agent;
  return `<div class="item ${t.status === "running" ? "card active" : ""}" data-task="${t.id}">
    <div class="row between"><div class="t">#${t.id} ${esc(t.title)}</div>${tag(t.status)}</div>
    <div class="m">${esc(name)}${t.parent_id ? ` · крок задачі #${t.parent_id}` : ""} · ${t.model ? esc(t.model) : "модель ще не вибрана"} · ${money(t.cost, 4)} · ${fmtTime(t.created)}${t.important ? ' · <span class="gold">важлива</span>' : ""}${t.rework ? ` · доопрацювань: ${t.rework}` : ""}</div>
    ${t.error ? `<div class="m bad">${esc(t.error)}</div>` : ""}${t.review ? `<div class="m">Контролер: ${esc(t.review)}</div>` : ""}
    ${open && t.result ? `<pre>${esc(t.result)}</pre>` : ""}
    <div class="row" style="margin-top:6px">${["failed", "stopped", "needs_owner", "cancelled"].includes(t.status) ? `<button class="btn sm" data-tact="retry" data-id="${t.id}">Повторити</button>` : ""}
    ${["queued", "waiting", "running", "review", "review_running", "delegated"].includes(t.status) ? `<button class="btn sm danger" data-tact="cancel" data-id="${t.id}">Скасувати</button>` : ""}
    <button class="btn sm" data-topen="${t.id}">Деталі</button></div></div>`;
}
function bindTasks() {
  $$("[data-tact]").forEach((b) => b.addEventListener("click", async () => { await act(() => api(`/api/tasks/${b.dataset.id}/${b.dataset.tact}`, { method: "POST" }), "Готово"); render(true); }));
  $$("[data-topen]").forEach((b) => b.addEventListener("click", async () => {
    const t = await api(`/api/tasks/${b.dataset.topen}`); const box = b.closest("[data-task]");
    box.outerHTML = taskItem(t, true).replace("</div></div>", `</div>${t.children.length ? `<div class="m">Кроки: ${t.children.map((c) => `#${c.id} ${esc(AGENT_NAMES[c.agent] || c.agent)} — ${STATUS[c.status] || c.status}`).join("; ")}</div>` : ""}${t.costs.length ? `<div class="m">Запуски: ${t.costs.map((c) => `${esc(c.agent)}/${esc(c.model)} ${money(c.usd, 4)} (${c.tokens_in}+${c.tokens_out} ток.)`).join("; ")}</div>` : ""}</div>`);
    bindTasks();
  }));
}

const R = {
  async chat() {
    const [ap, tasks, costs, ag, mk] = await Promise.all([api("/api/approvals"), api("/api/tasks?limit=8"), api("/api/costs?days=7"),
      api("/api/agents"), api("/api/market").catch(() => null)]);
    const st = S.state || {};
    const active = tasks.filter((t) => !["done", "failed", "stopped", "cancelled", "needs_owner"].includes(t.status));
    const pct = st.limit ? (st.spent / st.limit) * 100 : 0;
    const node = ag.node || {};
    return `<div class="grid">
      ${card("Стан системи", `<div class="kpis">
        <div class="kpi"><b class="${st.halted ? "bad" : "ok"}">${st.halted ? "Зупинено" : "Працює"}</b><span>агенти</span></div>
        <div class="kpi"><b>${st.brain?.ok ? '<span class="ok">онлайн</span>' : '<span class="bad">офлайн</span>'}</b><span>${esc(st.brain?.name === "hermes" ? "Hermes Agent" : st.brain?.name || "")}</span></div>
        <div class="kpi"><b>${node.online ? '<span class="ok">онлайн</span>' : '<span class="dim">офлайн</span>'}</b><span>ПК-вузол</span></div>
        <div class="kpi"><b>${st.telegram ? "увімк." : '<span class="dim">вимк.</span>'}</b><span>Telegram</span></div></div>
        <div class="m dim" style="margin-top:8px">${esc(st.brain?.detail || "")} · голос: ${esc(st.stt || "")}</div>`)}
      ${card("Бюджет на сьогодні", `<div class="row between"><span class="big">${money(st.spent, 3)}</span><span class="muted">з ${money(st.limit)}</span></div>${bar(pct, pct > 90 ? "bad" : "gold")}
        <div class="m muted" style="margin-top:8px">Модель: <b>${{ auto: "авто (середня за замовчуванням)", cheap: "дешева", medium: "середня", strong: "сильна" }[st.model_mode] || st.model_mode}</b></div>
        <div class="m dim">Задач: працює ${st.running || 0}, у черзі ${st.queued || 0}</div>`)}
      ${card("Потрібне ваше рішення", approvalsHtml(ap), ap.length ? `<span class="badge">${ap.length}</span>` : "", "wide")}
      ${card("Активні задачі", active.length ? `<div class="list">${active.map((t) => taskItem(t)).join("")}</div>` : empty("Активних задач немає. Напишіть Джарвісу в чат."), `<button class="btn sm" data-go="tasks">Усі задачі</button>`)}
      ${card("Команда", `<div class="list">${ag.agents.map((a) => `<div class="row between"><span>${esc(a.icon)} ${esc(a.title)}</span><span class="tag ${a.status === "working" ? "running" : a.status === "waiting" ? "queued" : a.status === "stopped" ? "failed" : ""}">${{ working: "працює", waiting: "черга", idle: "вільний", stopped: "стоп" }[a.status]}</span></div>`).join("")}</div>`, `<button class="btn sm" data-go="agents">Схема</button>`)}
      ${mk && mk.price ? card("Золото XAU/USD", `<div class="row between"><span class="big">${Number(mk.price).toFixed(2)}</span><span class="muted">${esc(mk.ind?.trend || "")}</span></div>
        <div class="m muted">Демо-баланс ${money(mk.account?.balance)} · сьогодні ${money(mk.account?.day_pnl)} · відкрито: ${mk.open?.length || 0}</div>`, `<button class="btn sm" data-go="market">Ринок</button>`) : ""}
      ${card("Витрати за тиждень", `<canvas class="chart" id="costChart" style="height:150px"></canvas>`, "", "")}
    </div>`;
  },
  async tasks() {
    const f = store.get("taskFilter", "active");
    const [ap, tasks, audit] = await Promise.all([api("/api/approvals"), api("/api/tasks?limit=150"), api("/api/audit?limit=60")]);
    const shown = tasks.filter((t) => f === "all" ? true : f === "active" ? !["done", "cancelled"].includes(t.status) && !(t.status === "failed" && t.parent_id) : f === "problems" ? ["failed", "needs_owner", "stopped"].includes(t.status) : t.status === "done");
    return `<div class="grid">
      ${ap.length ? card("Чекають підтвердження", approvalsHtml(ap), "", "wide") : ""}
      ${card("Задачі", `<div class="seg" style="margin-bottom:10px">${[["active", "Активні"], ["problems", "Проблеми"], ["done", "Готові"], ["all", "Усі"]].map(([k, t]) => `<button data-filter="${k}" class="${f === k ? "on" : ""}">${t}</button>`).join("")}</div>
        ${shown.length ? `<div class="list">${shown.map((t) => taskItem(t)).join("")}</div>` : empty("Нічого немає.")}`, "", "wide")}
      ${card("Журнал дій", `<table class="t"><tr><th>Час</th><th>Хто</th><th>Дія</th><th>Деталі</th></tr>${audit.map((a) => `<tr><td class="dim">${fmtTime(a.ts)}</td><td>${esc(a.actor)}</td><td class="${a.level === "error" ? "bad" : a.level === "warn" ? "warn" : ""}">${esc(a.action)}</td><td class="muted">${esc(a.details).slice(0, 220)}</td></tr>`).join("")}</table>`, "", "wide")}
    </div>`;
  },
  async projects() {
    const list = await api("/api/projects");
    return `<div class="grid">
      ${card("Новий проєкт", `<form id="projForm" class="form"><div><label class="f">Назва</label><input name="name" required maxlength="80"></div>
        <div><label class="f">Напрям</label><select name="area"><option value="game">Гра</option><option value="video">Відео</option><option value="trading">Трейдинг</option><option value="research">Дослідження</option><option value="general">Інше</option></select></div>
        <div><label class="f">Прогрес %</label><input name="progress" type="number" min="0" max="100" value="0"></div><button class="btn primary">Додати</button></form>`, "", "wide")}
      ${list.length ? list.map((p) => card(esc(p.name), `<div class="row between"><span class="tag">${esc(p.area)}</span><span class="muted">${p.progress}%</span></div>${bar(p.progress, "gold")}
        ${p.notes ? `<div class="m muted" style="margin-top:8px;white-space:pre-wrap">${esc(p.notes)}</div>` : ""}
        <div class="row" style="margin-top:10px"><input type="number" min="0" max="100" value="${p.progress}" data-pprog="${p.id}" style="width:90px">
        <button class="btn sm" data-psave="${p.id}">Зберегти</button><button class="btn sm" data-pask="${esc(p.name)}">Доручити Джарвісу</button><button class="btn sm danger" data-pdel="${p.id}">Видалити</button></div>`)).join("") : card("Проєкти", empty("Проєктів ще немає. Додайте вручну або попросіть Джарвіса."))}
    </div>`;
  },
  async ideas() {
    const list = await api("/api/ideas");
    return `<div class="grid">${card("Нова ідея", `<form id="ideaForm" class="row"><input name="text" placeholder="Що покращити або зробити…" maxlength="1000" required><button class="btn primary">Додати</button></form>`, "", "wide")}
      ${card("Ідеї та пропозиції", list.length ? `<div class="list">${list.map((i) => `<div class="item"><div class="row between"><div class="t">${esc(i.text)}</div><span class="tag">${{ new: "нова", in_work: "в роботі", done: "зроблено", rejected: "відхилено" }[i.status] || esc(i.status)}</span></div>
        <div class="m">${i.source === "owner" ? "ваша" : "від " + esc(AGENT_NAMES[i.source] || i.source)} · ${fmtTime(i.created)}</div>
        <div class="row" style="margin-top:6px"><button class="btn sm primary" data-itask="${i.id}">У роботу</button><button class="btn sm" data-istat="${i.id}" data-s="done">Зроблено</button><button class="btn sm" data-istat="${i.id}" data-s="rejected">Відхилити</button><button class="btn sm danger" data-idel="${i.id}">Видалити</button></div></div>`).join("")}</div>` : empty("Ідей поки немає. Джарвіс теж додаватиме сюди свої пропозиції покращень."), "", "wide")}</div>`;
  },
  async agents() {
    const d = await api("/api/agents");
    const by = Object.fromEntries(d.agents.map((a) => [a.name, a]));
    const node = d.node || {};
    const nodeHtml = (a) => { if (!a) return ""; const cur = a.current ? `#${a.current.id} ${esc(a.current.title)}` : a.waiting ? `у черзі: ${a.waiting}` : "вільний";
      return `<div class="anode ${a.status}" id="an-${a.name}"><div class="nm"><span class="ic">${esc(a.icon)}</span>${esc(a.title)}</div><div class="st">${cur}<br><span class="dim">сьогодні ${money(a.cost_today, 3)}${a.generation > 1 ? ` · сесія ${a.generation}` : ""}</span></div></div>`; };
    const execs = d.agents.filter((a) => !["jarvis", "controller"].includes(a.name));
    return `<div class="grid">${card("Жива схема команди", `<div class="schema" id="schema"><svg id="links"></svg><div class="nodes">
        <div class="lvl-top">${nodeHtml(by.jarvis)}</div><div class="lvl-ctrl">${nodeHtml(by.controller)}</div>
        ${execs.map((a) => `<div>${nodeHtml(a)}</div>`).join("")}
        <div style="grid-column:1/-1"><div class="anode ${node.online ? "" : "offline"}" id="an-node"><div class="nm"><span class="ic">⌂</span>ПК-вузол ${node.name ? "· " + esc(node.name) : ""} <span class="dot ${node.online ? "on" : "off"}"></span></div>
          <div class="st">${node.online ? "онлайн" : "офлайн"}${node.last_seen ? " · був " + fmtTime(node.last_seen) : ""} · черга: ${node.queued || 0}${node.gpu ? " · " + esc(node.gpu) : ""}</div></div></div>
      </div></div>`, d.halted ? '<span class="tag failed">СТОП</span>' : "", "wide")}
      ${card("Агенти", `<table class="t"><tr><th>Агент</th><th>Роль</th><th>Сьогодні</th><th></th></tr>${d.agents.map((a) => `<tr><td>${esc(a.icon)} ${esc(a.title)}</td><td class="muted">${esc(a.role).slice(0, 160)}</td><td>${money(a.cost_today, 3)}</td><td><button class="btn sm" data-restart="${a.name}">Перезапустити</button></td></tr>`).join("")}</table>`, "", "wide")}
      ${card("Блокування файлів (Контролер)", d.locks.length ? `<div class="list">${d.locks.map((l) => `<div class="item"><span class="mono">${esc(l.resource)}</span> — задача #${l.task_id} (${esc(AGENT_NAMES[l.agent] || l.agent)})</div>`).join("")}</div>` : empty("Зараз ніхто не блокує файли."))}
      ${node.jobs ? card("Задачі ПК-вузла", node.jobs.length ? `<div class="list">${node.jobs.map((j) => `<div class="item"><div class="row between"><span class="t">#${j.id} ${esc(j.action)}</span>${tag(j.status === "sent" ? "running" : j.status === "error" ? "failed" : j.status)}</div><div class="m">${fmtTime(j.created)}${j.error ? ' · <span class="bad">' + esc(j.error) + "</span>" : ""}</div></div>`).join("")}</div>` : empty("Черга порожня.")) : ""}
    </div>`;
  },
  async reports() {
    const [list, costs] = await Promise.all([api("/api/reports"), api("/api/costs?days=30")]);
    const t = costs.today;
    return `<div class="grid">
      ${card("Витрати", `<canvas class="chart" id="costChart"></canvas><div class="m muted" style="margin-top:8px">Сьогодні ${money(t.total, 3)} з ${money(t.limit)}</div>
        <table class="t" style="margin-top:8px"><tr><th>Агент</th><th>Модель</th><th>Запусків</th><th>Токени</th><th>$</th></tr>${t.rows.map((r) => `<tr><td>${esc(AGENT_NAMES[r.agent] || r.agent)}</td><td class="mono">${esc(r.model)}</td><td>${r.n}</td><td class="dim">${r.tin}+${r.tout}</td><td>${money(r.usd, 4)}</td></tr>`).join("")}</table>`, "", "wide")}
      ${card("Щоденні звіти", (list.length ? `<div class="list">${list.map((r) => `<div class="item"><div class="t">Звіт за ${esc(r.day)}</div><pre>${esc(r.text)}</pre></div>`).join("")}</div>` : empty("Звітів ще немає. Перший прийде автоматично ввечері.")), `<button class="btn sm gold" id="reportNow">Сформувати зараз</button>`, "wide")}
    </div>`;
  },
  async settings() {
    const s = await api("/api/settings");
    const voices = ("speechSynthesis" in window) ? speechSynthesis.getVoices().filter((v) => /^(uk|ru|en)/i.test(v.lang)) : [];
    const curVoice = store.get("voiceName", "") || s.voice_name;
    return `<div class="grid">
      ${card("Модель", `<div class="seg" id="modeSeg">${[["auto", "Авто"], ["cheap", "Дешева"], ["medium", "Середня"], ["strong", "Сильна"]].map(([k, t]) => `<button data-mode="${k}" class="${s.model_mode === k ? "on" : ""}">${t}</button>`).join("")}</div>
        <div class="m muted" style="margin-top:10px">Авто: за замовчуванням середня; прості повідомлення — дешева, складні (архітектура, стратегія, глибокий аналіз) — сильна.</div>
        <table class="t" style="margin-top:8px"><tr><th>Рівень</th><th>Модель</th><th>$ за 1 млн токенів (вхід / вихід)</th></tr>${Object.entries(s.models).map(([k, m]) => `<tr><td>${{ cheap: "Дешева", medium: "Середня", strong: "Сильна" }[k]}</td><td class="mono">${esc(m)}</td><td>${s.prices[m] ? s.prices[m][0] + " / " + s.prices[m][1] : "—"}</td></tr>`).join("")}</table>`)}
      ${card("Денний ліміт витрат", `<form id="budgetForm" class="row"><input type="number" name="v" min="0.01" max="100" step="0.01" value="${s.daily_budget_usd}"><button class="btn primary">Зберегти</button></form>
        <div class="m muted" style="margin-top:8px">Коли ліміт вичерпано, нові задачі не запускаються до завтра. Агенти не можуть підняти ліміт без вашого підтвердження.</div>`)}
      ${card("Голос", `<label class="row"><input type="checkbox" id="ttsOn" ${store.get("tts", true) && s.tts ? "checked" : ""} style="width:auto"> Джарвіс озвучує відповіді</label>
        <div style="margin-top:10px"><label class="f">Голос озвучення (цей пристрій)</label><select id="voiceSel"><option value="">Автоматично (українська)</option>${voices.map((v) => `<option ${v.name === curVoice ? "selected" : ""}>${esc(v.name)}</option>`).join("")}</select></div>
        <div class="row" style="margin-top:10px"><button class="btn sm" id="voiceTest">Прослухати</button><span class="m dim">Розпізнавання: браузер + ${esc(s.stt)}</span></div>`)}
      ${card("Звіти", `<form id="hourForm" class="row"><label class="f" style="margin:0">Щоденний звіт о</label><input type="number" name="h" min="0" max="23" value="${s.report_hour}" style="width:80px"><span>:00</span><button class="btn sm primary">Зберегти</button></form>`)}
      ${card("Безпека", `<div class="stack"><div class="m muted">Вхід: пароль + 2FA. Скинути 2FA чи пароль можна лише з консолі сервера.</div>
        <div class="row"><button class="btn danger" id="logoutAll">Вийти на всіх пристроях</button><button class="btn" id="logout">Вийти</button></div>
        <div class="m muted">Telegram: ${s.telegram ? '<span class="ok">підключено</span>' : "не підключено (див. інструкцію)"} · Мозок: ${esc(s.brain)}</div></div>`)}
      ${card("Правила Джарвіса", `<div class="m" style="white-space:pre-wrap">${esc(RULES)}</div>`, "", "wide")}
    </div>`;
  },
};
const RULES = `Сам може: планувати й розподіляти задачі, створювати й перезапускати агентів, писати код, тексти, графіку й відео в робочих папках, шукати інформацію й аналізувати ринок, вибирати модель у межах ліміту, торгувати на демо-рахунку, зберігати роботу в окремих гілках GitHub і пропонувати покращення.
Тільки з вашого підтвердження: витрачати гроші, відкривати реальні угоди чи змінювати ліміти ризику, публікувати від вашого імені, видаляти файли, проєкти чи агентів, змінювати свій код у головній гілці чи налаштування сервера, виконувати на ПК нові дії поза білим списком.
Ніколи: обходити правила, показувати чи записувати в код ключі й паролі, відкривати доступ стороннім, робити щось незаконне, приховувати помилки чи збитки.
Захист: денний ліміт витрат, журнал усіх дій, кнопка «Стоп» і команда stop у Telegram миттєво зупиняють усіх агентів.`;

// ---------- обробники після рендеру ----------
const A = {
  chat() { bindApprovals(); bindTasks(); bindGo(); costChart(7); },
  tasks() { bindApprovals(); bindTasks(); $$("[data-filter]").forEach((b) => b.addEventListener("click", () => { store.set("taskFilter", b.dataset.filter); render(true); })); },
  projects() {
    $("#projForm").addEventListener("submit", async (e) => { e.preventDefault(); const f = new FormData(e.target);
      await act(() => api("/api/projects", { method: "POST", body: Object.fromEntries(f) }), "Проєкт додано"); render(); });
    $$("[data-psave]").forEach((b) => b.addEventListener("click", async () => { const id = b.dataset.psave; const p = (await api("/api/projects")).find((x) => x.id == id);
      await act(() => api("/api/projects", { method: "POST", body: { ...p, progress: $(`[data-pprog="${id}"]`).value } }), "Збережено"); render(true); }));
    $$("[data-pdel]").forEach((b) => b.addEventListener("click", async () => { if (!confirm("Видалити проєкт?")) return; await act(() => api(`/api/projects/${b.dataset.pdel}`, { method: "DELETE" }), "Видалено"); render(true); }));
    $$("[data-pask]").forEach((b) => b.addEventListener("click", () => { go("chat"); input.value = `Проєкт «${b.dataset.pask}»: проаналізуй стан і запропонуй наступні кроки.`; input.focus(); }));
  },
  ideas() {
    $("#ideaForm").addEventListener("submit", async (e) => { e.preventDefault(); await act(() => api("/api/ideas", { method: "POST", body: { text: e.target.text.value } }), "Ідею додано"); render(); });
    $$("[data-itask]").forEach((b) => b.addEventListener("click", async () => { await act(() => api(`/api/ideas/${b.dataset.itask}/task`, { method: "POST" }), "Передано Джарвісу"); render(true); }));
    $$("[data-istat]").forEach((b) => b.addEventListener("click", async () => { await act(() => api("/api/ideas", { method: "POST", body: { id: b.dataset.istat, status: b.dataset.s } })); render(true); }));
    $$("[data-idel]").forEach((b) => b.addEventListener("click", async () => { await act(() => api(`/api/ideas/${b.dataset.idel}`, { method: "DELETE" })); render(true); }));
  },
  agents() {
    $$("[data-restart]").forEach((b) => b.addEventListener("click", async () => { if (!confirm("Перезапустити агента? Його поточна розмова почнеться з нуля.")) return; await act(() => api(`/api/agents/${b.dataset.restart}/restart`, { method: "POST" }), "Перезапущено"); render(true); }));
    drawLinks();
  },
  reports() {
    costChart(30);
    $("#reportNow").addEventListener("click", async () => { await act(() => api("/api/reports/now", { method: "POST" }), "Звіт сформовано"); render(); });
  },
  settings() {
    $$("[data-mode]").forEach((b) => b.addEventListener("click", async () => { await act(() => api("/api/settings", { method: "POST", body: { model_mode: b.dataset.mode } }), "Модель змінено"); render(true); loadState(); }));
    $("#budgetForm").addEventListener("submit", async (e) => { e.preventDefault(); await act(() => api("/api/settings", { method: "POST", body: { daily_budget_usd: +e.target.v.value } }), "Ліміт збережено"); loadState(); });
    $("#hourForm").addEventListener("submit", async (e) => { e.preventDefault(); await act(() => api("/api/settings", { method: "POST", body: { report_hour: +e.target.h.value } }), "Збережено"); });
    $("#ttsOn").addEventListener("change", (e) => { store.set("tts", e.target.checked); api("/api/settings", { method: "POST", body: { tts: e.target.checked } }); });
    $("#voiceSel").addEventListener("change", (e) => { store.set("voiceName", e.target.value); });
    $("#voiceTest").addEventListener("click", () => speak("Добрий день. Я Джарвіс, ваш персональний асистент. Усі системи працюють."));
    $("#logoutAll").addEventListener("click", async () => { if (confirm("Завершити всі сесії, включно з цією?")) { await api("/api/logout-all", { method: "POST" }); showLogin(); } });
    $("#logout").addEventListener("click", async () => { await api("/api/logout", { method: "POST" }); showLogin(); });
  },
};
function bindGo() { $$("[data-go]").forEach((b) => b.addEventListener("click", () => go(b.dataset.go))); }

function drawLinks() {
  const box = $("#schema"), svg = $("#links"); if (!box || !svg || window.innerWidth <= 860) return;
  const r0 = box.getBoundingClientRect(); const c = (id, side) => { const e = $("#an-" + id); if (!e) return null; const r = e.getBoundingClientRect();
    return { x: r.left - r0.left + r.width / 2, y: side === "top" ? r.top - r0.top : r.bottom - r0.top }; };
  const live = (id) => $("#an-" + id)?.classList.contains("working");
  const paths = []; const j = c("jarvis", "bottom"), ct = c("controller", "top"), cb = c("controller", "bottom");
  if (j && ct) paths.push([j, ct, live("controller")]);
  $$(".anode[id^=an-]").map((e) => e.id.slice(3)).filter((n) => !["jarvis", "controller", "node"].includes(n)).forEach((n) => {
    const t = c(n, "top"); if (cb && t) paths.push([cb, t, live(n)]); const b = c(n, "bottom"), nd = c("node", "top");
    if (b && nd && ["game", "video"].includes(n)) paths.push([b, nd, false]); });
  svg.innerHTML = paths.map(([a, b, l]) => `<path class="${l ? "live" : ""}" d="M${a.x},${a.y} C${a.x},${(a.y + b.y) / 2} ${b.x},${(a.y + b.y) / 2} ${b.x},${b.y}"/>`).join("");
}
window.addEventListener("resize", () => S.view === "agents" && drawLinks());

async function costChart(days) {
  const cv = $("#costChart"); if (!cv) return;
  const d = await api(`/api/costs?days=${days}`).catch(() => null); if (!d) return;
  const dpr = window.devicePixelRatio || 1; cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr;
  const g = cv.getContext("2d"), rows = d.days, max = Math.max(d.today.limit || 0, ...rows.map((r) => r.usd), 0.01);
  const W = cv.width, H = cv.height, pad = 22 * dpr, bw = rows.length ? (W - pad) / rows.length : W;
  g.font = `${10 * dpr}px sans-serif`; g.fillStyle = "#5d6b84";
  const ly = H - pad - ((d.today.limit || 0) / max) * (H - pad * 1.6);
  g.strokeStyle = "rgba(201,168,92,.5)"; g.setLineDash([4 * dpr, 4 * dpr]); g.beginPath(); g.moveTo(pad, ly); g.lineTo(W, ly); g.stroke(); g.setLineDash([]);
  g.fillText("ліміт", pad, ly - 4 * dpr);
  rows.forEach((r, i) => { const h = (r.usd / max) * (H - pad * 1.6); const x = pad + i * bw + bw * .2;
    const gr = g.createLinearGradient(0, H - pad - h, 0, H - pad); gr.addColorStop(0, "#8fdcff"); gr.addColorStop(1, "#1c4f73");
    g.fillStyle = gr; g.fillRect(x, H - pad - h, bw * .6, h); g.fillStyle = "#5d6b84"; g.fillText(r.day.slice(8), x, H - 6 * dpr); });
  if (!rows.length) { g.fillStyle = "#5d6b84"; g.fillText("Ще немає витрат", pad, H / 2); }
}

// ---------- модулі наступних етапів підключаються тут ----------
export { api, act, card, esc, money, fmtTime, bar, empty, tag, R, A, store, toast, render, go, S, input };
for (const mod of ["market", "game"]) import(`/static/${mod}.js?v=1`).then((m) => m.install && m.install()).catch(() => {
  R[mod] = async () => card(mod === "market" ? "Ринок" : "Гра та бізнес", empty("Модуль ще не підключено."), "", "wide");
});

// ---------- запуск ----------
async function boot() {
  $("#login").hidden = true; $("#app").hidden = false;
  buildNav();
  await loadState();
  await loadMessages();
  connectStream();
  const v = location.hash.slice(1) || store.get("view", "chat");
  go(VIEWS.some((x) => x[0] === v) ? v : "chat");
  setInterval(loadState, 30000);
}
(async () => {
  const me = await fetch("/api/me").then((r) => r.json()).catch(() => ({}));
  if (me.auth) boot(); else showLogin();
  if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => S.view === "settings" && render(true);
})();
