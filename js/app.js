/* ====== НАЛАШТУВАННЯ — змінюйте тут ====== */
const CONFIG = {
  userName: "Djek",
  userRole: "CEO",
  city: "München",
  lat: 48.137, lon: 11.575,
  githubRepo: "greenbullhelp/Start-VLASTELIN-AI-Office-",
  aiConnected: false, // стане true, коли підключимо AI-модель через сервер
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
function say(html) { $("bubble").innerHTML = html; bustApi && bustApi.speak(); }

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
  const t = text.toLowerCase();
  if (/проєкт|проект/.test(t) && /(створ|додай|новий)/.test(t)) {
    const name = text.replace(/.*(проєкт|проект)\s*/i, "").trim();
    if (name) { addProject(name); say(`<b>Готово.</b><br>Проєкт «${esc(name)}» створено.`); return; }
  }
  if (/час|котра/.test(t)) { say(`<b>Зараз ${$("time").textContent}</b>`); return; }
  if (/погода/.test(t)) { say(`<b>${esc(CONFIG.city)}:</b> ${$("wTemp").textContent} ${$("wIcon").textContent}`); return; }
  if (/звіт/.test(t)) { makeReport(); return; }
  if (!CONFIG.aiConnected) {
    say(`<b>Команду прийнято:</b> «${esc(text)}»<br><span class="muted">Для розумних відповідей потрібно підключити AI-модель. Поки я розумію: «створи проєкт …», «котра година», «погода», «звіт».</span>`);
  }
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
const setDot = (id, s) => { $(id).className = "dot " + s; };
async function checkStatus() {
  const net = navigator.onLine; setDot("sNet", net ? "ok" : "bad");
  let git = false;
  try { git = (await fetch(`https://api.github.com/repos/${CONFIG.githubRepo}`)).ok; } catch (e) {}
  setDot("sGit", git ? "ok" : "bad");
  const ai = CONFIG.aiConnected;
  setDot("sAi", ai ? "ok" : "warn"); $("sAiTxt").textContent = ai ? "· онлайн" : "· очікує";
  setDot("aiDot", ai ? "ok" : "warn"); $("aiState").textContent = ai ? "Онлайн" : "Базовий режим";
  $("aiState").parentElement.classList.toggle("ok", ai);
  const all = net && git && ai;
  setDot("sAll", all ? "ok" : net ? "warn" : "bad");
  $("sAllTxt").textContent = all ? "Усі системи ОК" : net ? "Частково активна" : "Є проблеми";
  setDot("miniDot", all ? "ok" : net ? "warn" : "bad");
  $("miniTitle").textContent = net ? "Система активна" : "Немає зв'язку";
  $("miniSub").textContent = all ? "Усі сервіси в мережі" : net ? (git ? "AI-модель очікує підключення" : "GitHub недоступний") : "Перевірте інтернет";
}
checkStatus();
addEventListener("online", checkStatus);
addEventListener("offline", checkStatus);
