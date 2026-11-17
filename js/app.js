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
let section = "home";   // відкритий розділ навігації (home — панель закрита)
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
    bustApi = initAssistant($("bust"), { lite: officeApi.lite });
    document.body.classList.toggle("lite", officeApi.lite);
    if (section !== "home") { officeApi.setPaused(true); bustApi.setPaused(true); }
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

/* ====== навігація (панелі розділів — див. кінець файлу) ====== */
const SLUGS = { "Головна": "home", "Бізнес-центр": "business", "Проєкти": "projects", "Фінанси": "finance", "Розробка": "dev",
  "Медіацентр": "media", "Комунікації": "comms", "Аналітика": "analytics", "Налаштування": "settings" };
function setActive(slug) {
  document.querySelectorAll(".menu button").forEach(x => x.classList.toggle("active", SLUGS[x.dataset.s] === slug));
}
$("menu").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  const slug = SLUGS[b.dataset.s];
  if (slug === "settings") { setActive("settings"); openSettings(); return; }
  go(slug);
});

/* ====== проєкти ====== */
let projects = store.get("vl_projects", CONFIG.defaultProjects)
  .map(p => typeof p === "string" ? { name: p, progress: 10, icon: "◆" } : p);
function renderProjects(keepPanel) {
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
  if (!keepPanel) refreshPanel("projects", "business", "analytics");
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
  refreshPanel("business", "analytics");
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
const FIN_DEMO = [20, 24, 22, 30, 28, 34, 31, 38, 36, 44, 41, 50, 48, 56];   // демо-крива, не реальні дані
function sparkPath(pts, w = 300, h = 60, max = 60) {
  const step = w / (pts.length - 1);
  return pts.map((v, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)} ${(h - v / max * h).toFixed(1)}`).join(" ");
}
(function () {
  const line = sparkPath(FIN_DEMO);
  $("sparkLine").setAttribute("d", line); $("sparkArea").setAttribute("d", line + " L300 60 L0 60 Z");
})();
$("finBtn").onclick = () => go("finance");

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
let netOk = navigator.onLine, gitOk = false, checked = false, agentMsg = "";
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
  refreshPanel("business", "dev", "analytics");
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
  try { gitOk = (await fetch(`https://api.github.com/repos/${CONFIG.githubRepo}`)).ok; } catch (e) { gitOk = false; }
  setDot("sGit", gitOk ? "ok" : "bad");
  const r = await pingAgent(); agentMsg = r.msg; checked = true;
  setAiState(r.ok);
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
addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  if (!$("settings").hidden) closeSettings();
  else if ($("assistant").classList.contains("big")) toggleBig(false);
  else if (section !== "home") go("home");
});

/* ====== налаштування агента ====== */
function openSettings() {
  $("setUrl").value = agent.url || ""; $("setCode").value = agent.code || ""; $("setVoice").checked = !!agent.voice;
  $("setNote").className = "set-note"; $("setNote").textContent = "Код доступу зберігається лише в цьому браузері. Ключ Claude API на сайт не потрапляє — він лежить на сервері агента.";
  $("settings").hidden = false; $("backdrop").classList.add("show"); $("setUrl").focus();
}
function closeSettings() { $("settings").hidden = true; if (!$("assistant").classList.contains("big")) $("backdrop").classList.remove("show"); setActive(section); }
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

/* ====== панелі розділів ====== */
const pct = p => Math.max(0, Math.min(100, p.progress | 0));
function stats() {
  const n = projects.length, sum = projects.reduce((s, p) => s + pct(p), 0);
  return { n, avg: n ? Math.round(sum / n) : 0, done: projects.filter(p => pct(p) >= 100).length, ev: events.length };
}
const tile = (label, value, sub = "") => `<div class="tile"><small>${label}</small><b${/[a-zа-яіїєґ]{3}/i.test(String(value).replace(/<[^>]+>/g, "")) ? ' class="txt"' : ""}>${value}</b>${sub ? `<span>${sub}</span>` : ""}</div>`;
const statusRows = () => [
  ["Інтернет", netOk ? "ok" : "bad", netOk ? "є з'єднання" : "немає з'єднання"],
  ["GitHub API", !checked ? "" : gitOk ? "ok" : "bad", !checked ? "перевірка…" : gitOk ? "доступний" : "недоступний"],
  ["AI-агент", aiOnline ? "ok" : !checked ? "" : agentReady() ? "bad" : "warn", aiOnline ? "онлайн" : !checked ? "перевірка…" : agentReady() ? "немає зв'язку" : "не налаштований"]
].map(([n, st, t]) => `<li><span class="dot ${st}"></span><span>${n}</span><span class="muted">${t}</span></li>`).join("");
const aiTxt = () => aiOnline ? "Онлайн" : !checked ? "…" : agentReady() ? "Немає зв'язку" : "Не налаштований";
const note = t => `<p class="sp-note">${t}</p>`;
const LOCAL_NOTE = note("Усі цифри обчислено з даних цього браузера (localStorage) і оновлюються автоматично.");
const eventsList = () => {
  events.sort((a, b) => a.t.localeCompare(b.t));
  return `<ul class="sp-events">${events.map((ev, i) => `<li><time>${esc(ev.t)}</time><span>${esc(ev.title)}</span><button class="sp-x" data-act="ev-del" data-i="${i}" aria-label="Видалити подію">×</button></li>`).join("") || `<li class="empty">Подій немає</li>`}</ul>
    <div class="sp-form"><input id="spETime" type="time" value="12:00" aria-label="Час"><input id="spETitle" placeholder="Нова подія" maxlength="80" data-enter="ev-add" aria-label="Назва події"><button class="btn-gold" data-act="ev-add">Додати</button></div>`;
};
let commits = null, commitsAt = 0;
async function loadCommits() {
  if (Date.now() - commitsAt < 5 * 60e3) return;
  commitsAt = Date.now();
  try {
    const r = await fetch(`https://api.github.com/repos/${CONFIG.githubRepo}/commits?per_page=5`);
    if (!r.ok) throw new Error(r.status);
    commits = (await r.json()).map(c => ({ sha: c.sha.slice(0, 7), url: c.html_url, msg: c.commit.message.split("\n")[0], date: c.commit.author.date }));
  } catch (e) { commits = []; }
  refreshPanel("dev");
}
const soon = (what, items, extra = "") => `<div class="sp-soon"><span class="badge">У РОЗРОБЦІ</span><p>${what}</p>
  <h3>Що тут буде</h3><ul class="sp-plan">${items.map(i => `<li>${i}</li>`).join("")}</ul>${extra}
  ${note("Розділ ще не підключений, тому тут немає даних — ми не показуємо вигаданих цифр.")}</div>`;
const bars = (rows, cls = "") => `<ul class="sp-bars ${cls}">${rows.map(([n, w, v]) => `<li><span>${esc(n)}</span><i><b style="width:${w}%"></b></i><code>${v}</code></li>`).join("")}</ul>`;

const VIEWS = {
  business: { ico: "▤", title: "БІЗНЕС-ЦЕНТР", render() {
    const s = stats(), top = projects.filter(p => pct(p) < 100).sort((a, b) => pct(b) - pct(a)).slice(0, 3);
    return `<div class="sp-tiles">${tile("Проєкти", s.n, `завершено: ${s.done}`)}${tile("Середній прогрес", s.avg + "%")}${tile("Подій сьогодні", s.ev)}${tile("AI-агент", aiTxt())}</div>
      <div class="sp-cols">
        <section class="sp-box"><h3>Розклад на сьогодні</h3>${eventsList()}</section>
        <section class="sp-box"><h3>Найближчі до завершення</h3>
          ${top.length ? bars(top.map(p => [p.name, pct(p), pct(p) + "%"])) : `<p class="empty">Немає активних проєктів</p>`}
          <div class="sp-actions"><a class="btn-ghost" href="#projects">Усі проєкти →</a></div>
          <h3>Стан систем</h3><ul class="sp-status">${statusRows()}</ul></section>
      </div>${LOCAL_NOTE}`;
  } },
  projects: { ico: "▣", title: "ПРОЄКТИ", render() {
    const s = stats();
    return `<div class="sp-form"><input id="spPName" placeholder="Назва нового проєкту" maxlength="80" data-enter="p-add" aria-label="Назва нового проєкту"><button class="btn-gold" data-act="p-add">+ Додати</button></div>
      <p class="sp-sum">Усього: <b>${s.n}</b> · середній прогрес: <b>${s.avg}%</b> · завершено: <b>${s.done}</b></p>
      <ul class="sp-projects">${projects.map((p, i) => `<li>
        <i class="pi">${esc(p.icon || "◆")}</i>
        <div class="pm"><b>${esc(p.name)}</b><input type="range" min="0" max="100" step="1" value="${pct(p)}" data-act="p-prog" data-i="${i}" aria-label="Прогрес: ${esc(p.name)}"></div>
        <output id="spPv${i}">${pct(p)}%</output>
        <button class="sp-x" data-act="p-del" data-i="${i}" aria-label="Видалити проєкт ${esc(p.name)}">×</button></li>`).join("") || `<li class="empty">Проєктів поки немає — додайте перший.</li>`}</ul>
      ${note("Прогрес змінюйте повзунком. Список спільний з панеллю «Проєкти» на головній і з AI-агентом.")}`;
  } },
  finance: { ico: "⬡", title: "ФІНАНСИ", render() {
    const line = sparkPath(FIN_DEMO, 600, 140);
    return `<div class="sp-demo"><span class="badge gold">DEMO</span> Це демонстраційні цифри, а не реальні дані компанії.</div>
      <div class="sp-tiles">${tile("Баланс компанії · DEMO", esc($("balance").textContent))}${tile("Зміна · DEMO", '<span class="up">↗ +12.5%</span>')}</div>
      <section class="sp-box"><h3>Динаміка · DEMO</h3>
        <svg class="sp-spark" viewBox="0 0 600 140" preserveAspectRatio="none" aria-hidden="true"><path d="${line} L600 140 L0 140 Z" fill="url(#sparkFill)"/><path d="${line}" fill="none" stroke="#ffd88a" stroke-width="2.5" vector-effect="non-scaling-stroke"/></svg></section>
      <section class="sp-box"><h3>Наступний крок</h3><ul class="sp-plan"><li>Підключити реальне джерело: таблицю (CSV / Google Sheets) або банк.</li><li>Доходи й витрати по кожному проєкту.</li><li>Прогноз руху коштів від AI-агента.</li></ul></section>`;
  } },
  dev: { ico: "‹›", title: "РОЗРОБКА", render() {
    loadCommits();
    const repo = `https://github.com/${CONFIG.githubRepo}`;
    const gfx = document.body.classList.contains("no-webgl") ? "WebGL недоступний — 3D вимкнено"
      : `Three.js r160 · режим ${document.body.classList.contains("eco") ? "ECO" : "MAX"}${officeApi && officeApi.lite ? " · полегшений профіль (телефон / слабкий пристрій)" : ""}`;
    return `<div class="sp-cols">
        <section class="sp-box"><h3>Репозиторій</h3>
          <p class="sp-repo"><code>${esc(CONFIG.githubRepo)}</code></p>
          <div class="sp-actions"><a class="btn-gold" href="${repo}" target="_blank" rel="noopener">Відкрити на GitHub ↗</a><a class="btn-ghost" href="${repo}/issues" target="_blank" rel="noopener">Issues ↗</a><a class="btn-ghost" href="${repo}/commits" target="_blank" rel="noopener">Коміти ↗</a></div>
          <h3>Останні зміни</h3>
          <ul class="sp-commits">${commits === null ? `<li class="empty">Завантаження…</li>` : commits.length ? commits.map(c => `<li><a href="${esc(c.url)}" target="_blank" rel="noopener"><code>${esc(c.sha)}</code></a><span>${esc(c.msg)}</span><small>${new Date(c.date).toLocaleDateString("uk-UA")}</small></li>`).join("") : `<li class="empty">Не вдалося завантажити з GitHub API.</li>`}</ul></section>
        <section class="sp-box"><h3>Стан систем</h3><ul class="sp-status">${statusRows()}</ul>
          ${agentReady() ? `<p class="sp-note">${esc(agentMsg || "Перевіряю…")}</p>` : ""}
          <p class="sp-note">Адреса агента: ${agent.url ? `<code>${esc(agent.url)}</code>` : "не задано"}</p>
          <div class="sp-actions"><button class="btn-ghost" data-act="recheck">Перевірити знову</button><button class="btn-ghost" data-act="settings">Налаштування агента</button></div>
          <h3>Графіка</h3><p class="sp-note">${gfx}</p></section>
      </div>`;
  } },
  media: { ico: "▶", title: "МЕДІАЦЕНТР", render() {
    return soon("Медіацентр — місце для матеріалів офісу: файлів, записів і контенту, підготовленого разом з AI-агентом.",
      ["Бібліотека файлів і зображень по проєктах", "Записи зустрічей і голосові нотатки", "Тексти й пости, підготовлені AI-агентом", "Швидкий пошук по всіх матеріалах"]);
  } },
  comms: { ico: "◎", title: "КОМУНІКАЦІЇ", render() {
    return soon("Комунікації — пошта, месенджери й контакти в одному вікні, з чернетками відповідей від AI-агента.",
      ["Вхідні повідомлення з пошти та месенджерів", "Картки клієнтів і партнерів", "Нагадування про відповіді й зустрічі", "Чернетки відповідей від AI-агента"],
      `<div class="sp-actions"><button class="btn-gold" data-act="voice">Голосова команда асистенту</button></div>`);
  } },
  analytics: { ico: "◢", title: "АНАЛІТИКА", render() {
    const s = stats(), sorted = projects.slice().sort((a, b) => pct(b) - pct(a));
    const stages = [["Старт · 0–33%", 0, 33], ["В роботі · 34–66%", 34, 66], ["Фініш · 67–99%", 67, 99], ["Готово · 100%", 100, 100]]
      .map(([n, lo, hi]) => { const c = projects.filter(p => pct(p) >= lo && pct(p) <= hi).length; return [n, s.n ? c / s.n * 100 : 0, c]; });
    const am = events.filter(e => e.t < "12:00").length;
    return `<div class="sp-tiles">${tile("Проєктів", s.n)}${tile("Середній прогрес", s.avg + "%")}${tile("Завершено", s.done)}${tile("Подій", s.ev, `до 12:00: ${am} · після: ${s.ev - am}`)}</div>
      <div class="sp-cols">
        <section class="sp-box"><h3>Прогрес по проєктах</h3>${sorted.length ? bars(sorted.map(p => [p.name, pct(p), pct(p) + "%"])) : `<p class="empty">Немає даних</p>`}</section>
        <section class="sp-box"><h3>Етапи</h3>${bars(stages, "gold")}
          <div class="sp-actions"><button class="btn-gold" data-act="report">Згенерувати звіт (.txt)</button></div></section>
      </div>${LOCAL_NOTE}`;
  } }
};

function placePanel() {   // на ПК панель займає простір праворуч від навігації; на телефоні — CSS
  const p = $("spanel");
  if (innerWidth > 900) {
    const r = document.querySelector(".nav").getBoundingClientRect();
    p.style.setProperty("--sp-l", Math.round(r.right + 14) + "px");
    p.style.setProperty("--sp-t", Math.round(Math.max(14, r.top)) + "px");
  }
}
function renderPanel() { if (VIEWS[section]) $("spBody").innerHTML = VIEWS[section].render(); }
function refreshPanel(...which) { if (section !== "home" && which.includes(section)) renderPanel(); }
function openPanel(slug) {
  const v = VIEWS[slug], first = section === "home";
  section = slug; setActive(slug);
  const name = Object.keys(SLUGS).find(k => SLUGS[k] === slug);
  const code = document.querySelector(`.menu button[data-s="${name}"] code`);
  $("spTitle").innerHTML = `<b class="ico">${esc(v.ico)}</b> ${v.title}`;
  $("spCode").textContent = `SYS.${code ? code.textContent : "00"} // ${slug.toUpperCase()}`;
  $("spanel").hidden = false; document.body.classList.add("sp-open");
  placePanel(); renderPanel(); $("spBody").scrollTop = 0;
  if (first) { $("spClose").focus({ preventScroll: true }); officeApi && officeApi.setPaused(true); bustApi && bustApi.setPaused(true); }
}
function closePanel() {
  const was = section !== "home";
  section = "home"; setActive("home");
  $("spanel").hidden = true; document.body.classList.remove("sp-open");
  if (was) { officeApi && officeApi.setPaused(false); bustApi && bustApi.setPaused(false); }
}
function route() { const s = location.hash.slice(1); VIEWS[s] ? openPanel(s) : closePanel(); }
function go(slug) {
  if (!VIEWS[slug]) { if (location.hash) window.history.replaceState(null, "", location.pathname + location.search); route(); return; }
  if (location.hash !== "#" + slug) location.hash = slug; else route();
}
addEventListener("hashchange", route);
addEventListener("resize", () => { if (section !== "home") placePanel(); });
$("spClose").onclick = () => go("home");
$("spDim").onclick = () => go("home");

const PANEL_ACTS = {
  "p-add"() { const v = $("spPName").value.trim(); if (v) addProject(v.slice(0, 80)); else $("spPName").focus(); },
  "p-del"(i) {
    const p = projects[i]; if (!p || !confirm(`Видалити проєкт «${p.name}»?`)) return;
    projects.splice(i, 1); renderProjects(); toast(`Проєкт «${p.name}» видалено`);
  },
  "ev-add"() {
    const title = $("spETitle").value.trim(); if (!title) { $("spETitle").focus(); return; }
    events.push({ t: $("spETime").value || "12:00", title: title.slice(0, 80) }); renderEvents(); toast("Подію додано");
  },
  "ev-del"(i) { events.splice(i, 1); renderEvents(); },
  recheck() { checked = false; agentMsg = ""; commitsAt = 0; renderPanel(); checkStatus(); },
  settings() { setActive("settings"); openSettings(); },
  report() { makeReport(); },
  voice() { go("home"); startVoice(); }
};
$("spBody").addEventListener("click", e => {
  const b = e.target.closest("[data-act]"); if (!b || b.type === "range") return;
  const f = PANEL_ACTS[b.dataset.act]; if (f) f(+b.dataset.i);
});
$("spBody").addEventListener("keydown", e => { const a = e.target.dataset.enter; if (e.key === "Enter" && a) PANEL_ACTS[a](); });
$("spBody").addEventListener("input", e => {   // повзунок: оновлюємо віджет і підпис без перебудови панелі
  const el = e.target; if (el.dataset.act !== "p-prog") return;
  const p = projects[+el.dataset.i]; if (!p) return;
  p.progress = +el.value; $("spPv" + el.dataset.i).textContent = p.progress + "%"; renderProjects(true);
});
route();
