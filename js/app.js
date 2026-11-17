/* ====== НАЛАШТУВАННЯ — змінюйте тут ====== */
const CONFIG = {
  userName: "Djek",
  userRole: "CEO",
  city: "München",
  lat: 48.137, lon: 11.575,
  githubRepo: "greenbullhelp/Start-VLASTELIN-AI-Office-",
  agentUrl: "",       // адреса сервера агента; можна задати і в «Налаштуваннях» на сайті
  defaultProjects: [
    { name: "Транспортна компанія", progress: 64, icon: "◆" },
    { name: "Сайт нового покоління", progress: 82, icon: "◈" },
    { name: "AI-асистент для бізнесу", progress: 45, icon: "✦" },
    { name: "Енергетичний проєкт", progress: 28, icon: "⚡" }
  ],
  defaultEvents: [{ t: "09:00", title: "Зустріч з клієнтом" }, { t: "11:30", title: "Планування проєктів" }, { t: "14:00", title: "Аналіз ринку" }]
};

/* ====== helpers ====== */
const $ = id => document.getElementById(id);
const store = {
  get(k, f) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : f; } catch (e) { return f; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let toastTimer;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2800); }

let bustApi = null, officeApi = null;
function say(html, sec = 3) { $("bubble").innerHTML = html; bustApi && bustApi.speak(sec); }

/* ====== AI-агент ====== */
const agent = Object.assign({ url: CONFIG.agentUrl, code: "", voice: true }, store.get("vl_agent", {}));
let history = store.get("vl_history", []);
let aiOnline = false;
const agentReady = () => /^https:\/\//.test(agent.url || "");

function speakOut(text) {
  if (!agent.voice || !("speechSynthesis" in window) || !text) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "uk-UA"; u.rate = 1.02; u.pitch = .9;
    const v = speechSynthesis.getVoices().find(v => /^uk/i.test(v.lang));
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  } catch (e) {}
}

function runAction(a) {
  const i = a.input || {};
  if (a.name === "create_project" && i.name) {
    projects.push({ name: String(i.name).slice(0, 80), progress: Math.max(0, Math.min(100, i.progress | 0)), icon: "✦" });
    renderProjects(); return `створено проєкт «${i.name}»`;
  }
  if (a.name === "update_project_progress" && i.name) {
    const p = projects.find(p => p.name.toLowerCase() === String(i.name).toLowerCase())
      || projects.find(p => p.name.toLowerCase().includes(String(i.name).toLowerCase()));
    if (!p) return `проєкт «${i.name}» не знайдено`;
    p.progress = Math.max(0, Math.min(100, i.progress | 0)); renderProjects(); return `прогрес «${p.name}» → ${p.progress}%`;
  }
  if (a.name === "add_event" && i.title) {
    const t = /^\d{1,2}:\d{2}$/.test(i.time || "") ? i.time.padStart(5, "0") : "12:00";
    events.push({ t, title: String(i.title).slice(0, 80) }); renderEvents(); return `подію ${t} «${i.title}» додано`;
  }
  return null;
}

async function askAgent(text) {
  history.push({ role: "user", content: text });
  history = history.slice(-20);
  say(`<span class="thinking"><i></i><i></i><i></i></span> <span class="muted">Думаю…</span>`, 0);
  bustApi && bustApi.think(true);
  try {
    const ctx = { user: CONFIG.userName, city: CONFIG.city, now: new Date().toLocaleString("uk-UA"), projects, events };
    const r = await fetch(agent.url.replace(/\/+$/, "") + "/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Access-Code": agent.code || "" },
      body: JSON.stringify({ messages: history, context: ctx })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Помилка ${r.status}`);
    const done = (j.actions || []).map(runAction).filter(Boolean);
    let reply = (j.reply || "").trim();
    if (!reply) reply = done.length ? "Готово: " + done.join("; ") + "." : "Готово.";
    history.push({ role: "assistant", content: reply + (done.length ? `\n[виконано: ${done.join("; ")}]` : "") });
    store.set("vl_history", history.slice(-20));
    say(esc(reply).replace(/\n/g, "<br>") + (done.length ? `<br><span class="muted">✓ ${esc(done.join("; "))}</span>` : ""), Math.min(8, reply.length / 15));
    speakOut(reply);
    setAiState(true);
  } catch (e) {
    history.pop();
    say(`<b>Агент недоступний.</b><br><span class="muted">${esc(e.message || "Немає зв'язку")}. Перевірте «Налаштування».</span>`);
    setAiState(false);
  } finally {
    bustApi && bustApi.think(false);
  }
}

/* ====== 3D ====== */
async function boot3D() {
  const done = () => $("loader").classList.add("done");
  try {
    const gl = document.createElement("canvas").getContext("webgl2") || document.createElement("canvas").getContext("webgl");
    if (!gl) throw new Error("no webgl");
    const [{ initOffice }, { initAssistant }] = await Promise.all([import("./office3d.js"), import("./assistant3d.js")]);
    await new Promise(r => requestAnimationFrame(r));
    officeApi = initOffice($("office3d"), { stageEl: $("stage"), assistantEl: $("assistant") });
    bustApi = initAssistant($("bust"));
  } catch (e) {
    console.warn("3D недоступне:", e);
    document.body.classList.add("no-webgl");
  }
  setTimeout(done, 200);
}
boot3D();
setTimeout(() => $("loader").classList.add("done"), 7000); // запобіжник

/* ====== user ====== */
$("uName").textContent = CONFIG.userName;
$("uRole").textContent = CONFIG.userRole;
$("uInitial").textContent = CONFIG.userName.charAt(0).toUpperCase();
document.querySelectorAll(".uName").forEach(e => e.textContent = CONFIG.userName);
$("wCity").textContent = CONFIG.city;

/* ====== годинник ====== */
const MONTHS = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
function tick() {
  const d = new Date();
  $("time").textContent = d.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
  $("date").textContent = d.toLocaleDateString("uk-UA", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
  $("calDay").textContent = d.getDate();
  $("calMon").textContent = MONTHS[d.getMonth()];
}
tick(); setInterval(tick, 1000);

/* ====== погода (Open-Meteo, без ключа) ====== */
const wIcon = c => c === 0 ? "☀️" : c <= 2 ? "🌤️" : c === 3 ? "☁️" : c <= 48 ? "🌫️" : c <= 67 ? "🌧️" : c <= 77 ? "🌨️" : c <= 82 ? "🌦️" : "⛈️";
async function loadWeather() {
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${CONFIG.lat}&longitude=${CONFIG.lon}&current=temperature_2m,weather_code&timezone=auto`);
    const j = await r.json(), t = Math.round(j.current.temperature_2m);
    $("wTemp").textContent = (t > 0 ? "+" : "") + t + "°C";
    $("wIcon").textContent = wIcon(j.current.weather_code);
  } catch (e) { $("wTemp").textContent = "н/д"; }
}
loadWeather(); setInterval(loadWeather, 15 * 60 * 1000);

/* ====== навігація ====== */
$("menu").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  document.querySelectorAll(".menu button").forEach(x => x.classList.remove("active"));
  b.classList.add("active");
  if (b.dataset.s === "Налаштування") { openSettings(); return; }
  say(`<b>Розділ «${esc(b.dataset.s)}»</b><br>Відкрито. Наповнення цього розділу — наступний етап.`);
});

/* ====== проєкти ====== */
let projects = store.get("vl_projects", CONFIG.defaultProjects)
  .map(p => typeof p === "string" ? { name: p, progress: 10, icon: "◆" } : p);
function renderProjects() {
  $("pList").innerHTML = projects.map((p, i) => `
    <li>
      <i class="pi">${esc(p.icon || "◆")}</i>
      <span class="pn">${esc(p.name)}</span>
      <span class="meta"><button class="del" data-i="${i}" aria-label="Видалити">×</button></span>
      <span class="pp"><i style="width:${Math.max(0, Math.min(100, p.progress | 0))}%"></i></span>
      <span class="pv">${p.progress | 0}%</span>
    </li>`).join("") || `<li class="empty">Проєктів поки немає</li>`;
  $("pCount").textContent = projects.length;
  store.set("vl_projects", projects);
}
$("pList").addEventListener("click", e => {
  const b = e.target.closest("button[data-i]"); if (!b) return;
  const name = projects[b.dataset.i].name; projects.splice(b.dataset.i, 1); renderProjects(); toast(`Проєкт «${name}» видалено`);
});
function openProjectAdd() { $("pAddRow").classList.add("show"); $("pAddInput").focus(); }
function addProject(name) {
  const v = (name ?? $("pAddInput").value).trim(); if (!v) return;
  projects.push({ name: v, progress: 0, icon: "✦" }); $("pAddInput").value = ""; $("pAddRow").classList.remove("show"); renderProjects(); toast(`Проєкт «${v}» створено`);
}
$("pAddBtn").onclick = openProjectAdd;
$("dProject").onclick = openProjectAdd;
$("pAddOk").onclick = () => addProject();
$("pAddInput").onkeydown = e => { if (e.key === "Enter") addProject(); };
renderProjects();

/* ====== календар ====== */
let events = store.get("vl_events", CONFIG.defaultEvents);
function renderEvents() {
  events.sort((a, b) => a.t.localeCompare(b.t));
  const shown = events.slice(0, 3);
  $("eList").innerHTML = (shown.map((ev, i) => `<li><time>${esc(ev.t)}</time><span>${esc(ev.title)}</span><button data-i="${i}" aria-label="Видалити">×</button></li>`).join("")
    + (events.length > 3 ? `<li class="muted">+ ще ${events.length - 3}</li>` : "")) || `<li class="empty">Подій немає</li>`;
  store.set("vl_events", events);
}
$("eList").addEventListener("click", e => { const b = e.target.closest("button[data-i]"); if (!b) return; events.splice(b.dataset.i, 1); renderEvents(); });
$("eAddBtn").onclick = () => { $("eAddRow").classList.toggle("show"); $("eTitle").focus(); };
function addEvent() {
  const t = $("eTime").value || "12:00", title = $("eTitle").value.trim(); if (!title) return;
  events.push({ t, title }); $("eTitle").value = ""; $("eAddRow").classList.remove("show"); renderEvents(); toast("Подію додано");
}
$("eAddOk").onclick = addEvent;
$("eTitle").onkeydown = e => { if (e.key === "Enter") addEvent(); };
renderEvents();

/* ====== фінанси (демо) ====== */
(function () {
  const pts = [20, 24, 22, 30, 28, 34, 31, 38, 36, 44, 41, 50, 48, 56], max = 60, w = 300, h = 60, step = w / (pts.length - 1);
  const line = pts.map((v, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)} ${(h - v / max * h).toFixed(1)}`).join(" ");
  $("sparkLine").setAttribute("d", line); $("sparkArea").setAttribute("d", line + ` L${w} ${h} L0 ${h} Z`);
})();
$("finBtn").onclick = () => say(`<b>Фінанси</b><br>Зараз це демо-цифри. Наступний крок — підключити реальні дані.`);

/* ====== команди асистента ====== */
function handleCommand(text) {
  if (agentReady()) { askAgent(text); return; }
  const t = text.toLowerCase();
  if (/проєкт|проект/.test(t) && /(створ|додай|новий)/.test(t)) {
    const name = text.replace(/.*(проєкт|проект)\s*/i, "").trim();
    if (name) { addProject(name); say(`<b>Готово.</b><br>Проєкт «${esc(name)}» створено.`); return; }
  }
  if (/час|котра/.test(t)) { say(`<b>Зараз ${$("time").textContent}</b>`); return; }
  if (/погода/.test(t)) { say(`<b>${esc(CONFIG.city)}:</b> ${$("wTemp").textContent} ${$("wIcon").textContent}`); return; }
  if (/звіт/.test(t)) { makeReport(); return; }
  say(`<b>Команду прийнято:</b> «${esc(text)}»<br><span class="muted">AI-агент ще не підключений (Налаштування). Поки я розумію: «створи проєкт …», «котра година», «погода», «звіт».</span>`);
}
function sendCmd() { const v = $("cmdInput").value.trim(); if (!v) return; $("cmdInput").value = ""; handleCommand(v); }
$("cmdSend").onclick = sendCmd;
$("cmdInput").onkeydown = e => { if (e.key === "Enter") sendCmd(); };

/* ====== голос ====== */
["wave", "wave2"].forEach(id => {
  const w = $(id);
  for (let i = 0; i < 22; i++) { const b = document.createElement("i"); b.style.animationDelay = (Math.random() * 1.2).toFixed(2) + "s"; w.appendChild(b); }
});
let rec = null;
function setListening(v) {
  $("micBtn").classList.toggle("live", v); $("wave").classList.toggle("live", v); $("wave2").classList.toggle("live", v);
  bustApi && bustApi.listen(v);
}
function startVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { say("<b>Голос недоступний</b><br>Цей браузер не підтримує розпізнавання мови. Спробуйте Chrome або введіть текст."); return; }
  if (rec) { rec.stop(); return; }
  rec = new SR(); rec.lang = "uk-UA"; rec.interimResults = false;
  setListening(true); say("<b>Слухаю…</b>");
  rec.onresult = e => { $("cmdInput").value = e.results[0][0].transcript; sendCmd(); };
  rec.onerror = () => say("<b>Не розчув.</b><br>Спробуйте ще раз.");
  rec.onend = () => { rec = null; setListening(false); };
  rec.start();
}
$("micBtn").onclick = startVoice;
$("dVoice").onclick = startVoice;

/* ====== док ====== */
$("dClients").onclick = () => say(`<b>Пошук клієнтів</b><br>Модуль з'явиться після підключення AI-моделі та джерел даних.`);
$("dAnalysis").onclick = () => say(`<b>Аналіз даних</b><br>Активних проєктів: ${projects.length}. Середній прогрес: ${projects.length ? Math.round(projects.reduce((s, p) => s + (p.progress | 0), 0) / projects.length) : 0}%. Подій сьогодні: ${events.length}.`);
$("dBrowser").onclick = () => window.open("https://www.google.com", "_blank", "noopener");
function makeReport() {
  const d = new Date();
  const txt = [`VLASTELIN — звіт за ${d.toLocaleDateString("uk-UA")}`, "",
    `Проєкти (${projects.length}):`, ...projects.map(p => ` • ${p.name} — ${p.progress | 0}%`), "",
    `Події сьогодні (${events.length}):`, ...events.map(e => ` • ${e.t} — ${e.title}`)].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([txt], { type: "text/plain;charset=utf-8" }));
  a.download = `vlastelin-zvit-${d.toISOString().slice(0, 10)}.txt`; a.click();
  say("<b>Звіт згенеровано</b><br>Файл завантажено.");
}
$("dReport").onclick = makeReport;
$("modeBtn").onclick = () => {
  const eco = document.body.classList.toggle("eco");
  $("modeLabel").textContent = eco ? "ECO" : "MAX";
  officeApi && officeApi.setEco(eco); bustApi && bustApi.setEco(eco);
  toast(eco ? "Режим ECO: менше ефектів, менше навантаження" : "Режим MAX: повна графіка");
};

/* ====== статус системи (реальні перевірки) ====== */
const setDot = (id, st) => { $(id).className = "dot " + st; };
let netOk = navigator.onLine, gitOk = false;
function setAiState(ok) {
  aiOnline = ok;
  setDot("sAi", ok ? "ok" : agentReady() ? "bad" : "warn");
  $("sAiTxt").textContent = ok ? "· онлайн" : agentReady() ? "· немає зв'язку" : "· не налаштована";
  setDot("aiDot", ok ? "ok" : "warn"); $("aiState").textContent = ok ? "Онлайн" : "Базовий режим";
  $("aiState").parentElement.classList.toggle("ok", ok);
  const all = netOk && gitOk && ok;
  setDot("sAll", all ? "ok" : netOk ? "warn" : "bad");
  $("sAllTxt").textContent = all ? "Усі системи ОК" : netOk ? "Частково активна" : "Є проблеми";
  setDot("miniDot", all ? "ok" : netOk ? "warn" : "bad");
  $("miniTitle").textContent = netOk ? "Система активна" : "Немає зв'язку";
  $("miniSub").textContent = all ? "Усі сервіси в мережі" : !netOk ? "Перевірте інтернет" : !gitOk ? "GitHub недоступний" : "AI-агент не підключений";
}
async function pingAgent() {
  if (!agentReady()) return { ok: false, msg: "Адресу сервера не задано" };
  try {
    const r = await fetch(agent.url.replace(/\/+$/, "") + "/health");
    const j = await r.json();
    if (!j.ok) return { ok: false, msg: "Сервер відповів з помилкою" };
    if (!j.configured) return { ok: false, msg: "На сервері не задано ANTHROPIC_API_KEY" };
    return { ok: true, msg: `Зв'язок є · модель ${j.model}${j.protected ? " · захищено кодом" : " · без коду доступу!"}` };
  } catch (e) { return { ok: false, msg: "Сервер не відповідає — перевірте адресу" }; }
}
async function checkStatus() {
  netOk = navigator.onLine; setDot("sNet", netOk ? "ok" : "bad");
  // The repo is private, so an anonymous /repos/... call would 404; check that GitHub itself is reachable
  // (/rate_limit is CORS-enabled and does not consume the anonymous quota).
  try { gitOk = (await fetch("https://api.github.com/rate_limit")).ok; } catch (e) { gitOk = false; }
  setDot("sGit", gitOk ? "ok" : "bad");
  setAiState((await pingAgent()).ok);
}
checkStatus();
addEventListener("online", checkStatus);
addEventListener("offline", checkStatus);

/* ====== збільшений аватар ====== */
function toggleBig(v) {
  const big = v ?? !$("assistant").classList.contains("big");
  $("assistant").classList.toggle("big", big); $("backdrop").classList.toggle("show", big);
  $("bustExpand").textContent = big ? "×" : "⤢";
  bustApi && bustApi.setBig(big);
}
$("bustExpand").onclick = () => toggleBig();
$("backdrop").onclick = () => { toggleBig(false); closeSettings(); };
addEventListener("keydown", e => { if (e.key === "Escape") { toggleBig(false); closeSettings(); } });

/* ====== налаштування агента ====== */
function openSettings() {
  $("setUrl").value = agent.url || ""; $("setCode").value = agent.code || ""; $("setVoice").checked = !!agent.voice;
  $("setNote").className = "set-note"; $("setNote").textContent = "Код доступу зберігається лише в цьому браузері. Ключ Claude API на сайт не потрапляє — він лежить на сервері агента.";
  $("settings").hidden = false; $("backdrop").classList.add("show"); $("setUrl").focus();
}
function closeSettings() { $("settings").hidden = true; if (!$("assistant").classList.contains("big")) $("backdrop").classList.remove("show"); }
function readSettings() { agent.url = $("setUrl").value.trim(); agent.code = $("setCode").value; agent.voice = $("setVoice").checked; }
$("setClose").onclick = closeSettings;
$("setTest").onclick = async () => {
  readSettings(); $("setNote").className = "set-note"; $("setNote").textContent = "Перевіряю…";
  const r = await pingAgent(); $("setNote").className = "set-note " + (r.ok ? "ok" : "bad"); $("setNote").textContent = r.msg;
};
$("setClear").onclick = () => { history = []; store.set("vl_history", []); toast("Розмову очищено"); };
$("setSave").onclick = async () => {
  readSettings();
  if (agent.url && !agentReady()) { $("setNote").className = "set-note bad"; $("setNote").textContent = "Адреса має починатися з https://"; return; }
  store.set("vl_agent", agent); closeSettings(); toast("Налаштування збережено");
  const r = await pingAgent(); setAiState(r.ok);
  say(r.ok ? `<b>AI-агент підключений.</b><br>Чим можу допомогти?` : `<b>Налаштування збережено.</b><br><span class="muted">${esc(r.msg)}</span>`);
};
