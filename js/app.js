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
// Колекції, що синхронізуються між пристроями через сервер (крок 1 «Апгрейду»).
const SYNC_KEYS = { vl_projects: "projects", vl_events: "events", vl_ws: "ws", vl_history: "history" };
let applyingRemote = false, sync = null;   // sync створюється нижче, коли всі колекції вже оголошені
const store = {
  get(k, f) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : f; } catch (e) { return f; } },
  set(k, v) {
    try {
      const s = JSON.stringify(v), old = localStorage.getItem(k);
      localStorage.setItem(k, s);
      // Справжня зміна користувача (не перший запис значень за замовчуванням і не дані з сервера) → у чергу на синхронізацію.
      if (SYNC_KEYS[k] && old !== null && old !== s && !applyingRemote && sync) sync.touch(SYNC_KEYS[k]);
    } catch (e) {}
  }
};
// Cache-busting: index.html loads app.js?v=…; pass the same version on to the 3D modules.
const VER = new URL(import.meta.url).search;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let toastTimer;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2800); }

let bustApi = null, officeApi = null;
let section = "home";   // відкритий розділ навігації (home — панель закрита)
let mirrorSay = false, chatNotes = [];   // локальні відповіді (без агента) дублюються у вікно чату
function say(html, sec = 3) {
  $("bubble").innerHTML = html; bustApi && bustApi.speak(sec);
  if (mirrorSay) { chatNotes.push(html); renderChat(); }
}

/* ====== AI-агент ====== */
const agent = Object.assign({ url: CONFIG.agentUrl, code: "", voice: true }, store.get("vl_agent", {}));
let history = store.get("vl_history", []);
let aiOnline = false;
const agentReady = () => /^https:\/\//.test(agent.url || "");

/* ====== голос: чоловічий український, якщо пристрій його має ======
   Браузери не повідомляють стать голосу, тому розпізнаємо за назвою. Відомі чоловічі uk-голоси: Microsoft Ostap (Edge/Windows). */
const MALE_RE = /ostap|остап|\bmale\b|чолов|\bman\b|uk-ua-x-.*m\b/i;
const FEMALE_RE = /lesya|леся|polina|поліна|female|жіноч|woman/i;
const ukVoices = () => ("speechSynthesis" in window ? speechSynthesis.getVoices() : []).filter(v => /^uk/i.test(v.lang));
function pickVoice() {
  const list = ukVoices();
  if (agent.voiceName) { const v = list.find(v => v.name === agent.voiceName); if (v) return v; }
  return list.find(v => MALE_RE.test(v.name) && /natural|online|neural/i.test(v.name))
    || list.find(v => MALE_RE.test(v.name))
    || list.find(v => !FEMALE_RE.test(v.name))
    || list[0] || null;
}
const isMaleVoice = v => !!v && MALE_RE.test(v.name);
let voiceWarned = false;
// Повертає Promise, що виконується, коли Властелін договорив (потрібно для «Режиму розмови»).
function speakOut(text) {
  return new Promise(done => {
  if (!agent.voice || !("speechSynthesis" in window) || !text) return done();
  setTimeout(done, 90000);   // запобіжник, якщо браузер не повідомить про кінець
  try {
    speechSynthesis.cancel();
    const clean = String(text).replace(/\[виконано:[^\]]*\]/g, "").replace(/[•*#_`]/g, " ").replace(/https?:\/\/\S+/g, "посилання");
    const u = new SpeechSynthesisUtterance(clean);
    const v = pickVoice();
    u.lang = v ? v.lang : "uk-UA"; u.rate = 1; u.pitch = 1;   // природна висота: штучне зниження жіночого голосу звучить неприродно
    if (v) u.voice = v;
    if (!isMaleVoice(v) && !voiceWarned) {
      voiceWarned = true;
      toast(v ? "На цьому пристрої немає чоловічого українського голосу" : "На цьому пристрої немає українського голосу");
    }
    u.onend = u.onerror = () => done();
    speechSynthesis.speak(u);
  } catch (e) { done(); }
  });
}
function fillVoiceSelect() {
  const sel = $("setVoiceName"); if (!sel) return;
  const list = ukVoices(), auto = pickVoice();
  sel.innerHTML = `<option value="">Автоматично${auto ? ` (${esc(auto.name)})` : ""}</option>`
    + list.map(v => `<option value="${esc(v.name)}"${v.name === agent.voiceName ? " selected" : ""}>${esc(v.name)}${isMaleVoice(v) ? " — чоловічий" : FEMALE_RE.test(v.name) ? " — жіночий" : ""}</option>`).join("");
  $("setVoiceHint").textContent = !list.length ? "Український голос на цьому пристрої не знайдено."
    : list.some(isMaleVoice) ? "Чоловічий український голос є." : "Чоловічого українського голосу на цьому пристрої немає (на iPhone Apple має лише жіночий).";
}
if ("speechSynthesis" in window) speechSynthesis.addEventListener?.("voiceschanged", fillVoiceSelect);

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

let pending = false, lastMeta = null;
// Base64 photos are never written to localStorage: history keeps only the photo count.
const saveHistory = () => store.set("vl_history", history.slice(-20).map(({ _thumbs, ...m }) => m));

async function askAgent(text, imgs = []) {
  const entry = { role: "user", content: text || "Подивись на фото." };
  if (imgs.length) { entry.photos = imgs.length; entry._thumbs = imgs.map(i => i.url); }
  history.push(entry);
  history = history.slice(-20);
  pending = true; renderChat();
  say(`<span class="thinking"><i></i><i></i><i></i></span> <span class="muted">Думаю…</span>`, 0);
  bustApi && bustApi.think(true);
  try {
    const tasks = Object.entries(ws).flatMap(([s, w]) => (w && Array.isArray(w.tasks) ? w.tasks : [])
      .filter(t => t.status !== "done").map(t => ({ section: s, title: t.title, status: t.status }))).slice(0, 40);
    const ctx = { user: CONFIG.userName, city: CONFIG.city, now: new Date().toLocaleString("uk-UA"), projects, events, tasks, summary: officeSummary() };
    const r = await fetch(agent.url.replace(/\/+$/, "") + "/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Access-Code": agent.code || "" },
      body: JSON.stringify({
        messages: history.map(({ role, content }) => ({ role, content })), context: ctx,
        images: imgs.map(({ media_type, data }) => ({ media_type, data })),
        mode: $("chatDeep").checked ? "deep" : "auto"
      })
    });
    const j = await r.json().catch(() => ({}));
    if (j.budget) lastMeta = { ...(lastMeta || {}), budget: j.budget };
    if (!r.ok) throw new Error(j.error || `Помилка ${r.status}`);
    const done = (j.actions || []).map(runAction).filter(Boolean);
    const NOTE = { remember: "запам'ятав", forget: "забув", propose: "пропозиція" };
    for (const n of j.notes || []) if (NOTE[n.type]) done.push(`${NOTE[n.type]}: «${String(n.text).slice(0, 80)}»`);
    if (j.changed && (j.changed.memory || j.changed.proposals)) loadBrain(true);
    let reply = (j.reply || "").trim();
    if (!reply) reply = done.length ? "Готово: " + done.join("; ") + "." : "Готово.";
    history.push({ role: "assistant", content: reply + (done.length ? `\n[виконано: ${done.join("; ")}]` : ""), model: j.model });
    lastMeta = { model: j.model, cost: j.cost, budget: j.budget };
    saveHistory();
    say(esc(reply).replace(/\n/g, "<br>") + (done.length ? `<br><span class="muted">✓ ${esc(done.join("; "))}</span>` : ""), Math.min(8, reply.length / 15));
    const spoken = speakOut(reply);
    setAiState(true);
    if (talkMode()) spoken.then(() => setTimeout(() => { if (!$("chatwin").hidden && talkMode() && !rec && !pending) startVoice(true); }, 350));
  } catch (e) {
    history.pop();
    const msg = `<b>Агент недоступний.</b><br><span class="muted">${esc(e.message || "Немає зв'язку")}. Перевірте «Налаштування».</span>`;
    say(msg); chatNotes.push(msg);
    if (!/ліміт/i.test(e.message || "")) setAiState(false);
  } finally {
    pending = false; renderChat();
    bustApi && bustApi.think(false);
  }
}

/* ====== вікно чату з Властеліном ====== */
let attach = [];   // {media_type, data, url} — фото, підготовлені до надсилання
const modelName = m => /haiku/i.test(m || "") ? "Haiku" : /sonnet/i.test(m || "") ? "Sonnet" : /opus/i.test(m || "") ? "Opus" : (m || "");
function fmtMsg(text) {
  const m = String(text).match(/^([\s\S]*?)\n\[виконано: ([\s\S]*)\]$/);
  const body = esc(m ? m[1] : text).replace(/\n/g, "<br>");
  return m ? `${body}<span class="done">✓ ${esc(m[2])}</span>` : body;
}
function renderChat() {
  const log = $("chatLog"); if (!log || $("chatwin").hidden) return;
  const msgs = history.map(m => {
    const thumbs = m._thumbs ? `<div class="thumbs">${m._thumbs.map(u => `<img src="${esc(u)}" alt="Фото">`).join("")}</div>`
      : m.photos ? `<small>📷 фото: ${m.photos | 0}</small>` : "";
    return `<div class="msg ${m.role === "user" ? "me" : "ai"}">${thumbs}${fmtMsg(m.content)}${m.role === "assistant" && m.model ? `<small>${esc(modelName(m.model))}</small>` : ""}</div>`;
  }).join("");
  const hello = history.length || chatNotes.length ? "" : `<div class="msg sys">Вітаю, ${esc(CONFIG.userName)}! Я Властелін. Напишіть завдання або додайте фото 📷.<br>Прості запити обробляє економна модель, аналіз — потужніша.</div>`;
  const setup = agentReady() ? "" : `<div class="msg sys">AI-агент ще не підключений. <button class="linkish" id="chatSetup">Відкрити налаштування</button></div>`;
  log.innerHTML = hello + setup + msgs + chatNotes.map(h => `<div class="msg sys">${h}</div>`).join("")
    + (pending ? `<div class="msg ai"><span class="thinking"><i></i><i></i><i></i></span> <span class="muted">Думаю…</span></div>` : "");
  log.scrollTop = log.scrollHeight;
  const b = lastMeta && lastMeta.budget;
  $("chatMeta").textContent = [lastMeta && lastMeta.model ? `Остання відповідь: ${modelName(lastMeta.model)}` : "",
    lastMeta && typeof lastMeta.cost === "number" ? `$${lastMeta.cost.toFixed(4)}` : "",
    b ? `сьогодні $${b.spent.toFixed(3)} з $${b.limit.toFixed(2)}` : ""].filter(Boolean).join(" · ");
  $("chatSend").disabled = pending;
}
function renderAtt() {
  $("chatAtt").hidden = !attach.length;
  $("chatAtt").innerHTML = attach.map((a, i) => `<div><img src="${esc(a.url)}" alt="Фото ${i + 1}"><button data-i="${i}" aria-label="Прибрати фото">×</button></div>`).join("");
}
async function shrinkPhoto(file, max = 1280) {   // зменшуємо фото: менше токенів і швидше надсилання
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL("image/jpeg", .82);
    return { media_type: "image/jpeg", data: dataUrl.split(",")[1], url: dataUrl };
  } finally { URL.revokeObjectURL(url); }
}
async function addPhotos(files) {
  for (const f of [...files]) {
    if (attach.length >= 4) { toast("Можна додати до 4 фото"); break; }
    if (!/^image\//.test(f.type) && !/\.(heic|heif)$/i.test(f.name || "")) continue;
    try { attach.push(await shrinkPhoto(f)); } catch (e) { toast("Не вдалося прочитати фото"); }
  }
  renderAtt();
}
function growText() { const t = $("chatText"); t.style.height = "auto"; t.style.height = Math.min(140, t.scrollHeight + 2) + "px"; }
function openChat(prefill = "") {
  const was = !$("chatwin").hidden;
  $("chatwin").hidden = false; document.body.classList.add("chat-open");
  if (prefill) $("chatText").value = prefill;
  renderChat(); growText();
  if (!was && innerWidth <= 900) { officeApi && officeApi.setPaused(true); bustApi && bustApi.setPaused(true); }
  $("chatText").focus({ preventScroll: true });
}
function closeChat() {
  if ($("chatwin").hidden) return;
  stopVoice(false); try { speechSynthesis.cancel(); } catch (e) {}
  $("chatwin").hidden = true; document.body.classList.remove("chat-open");
  if (section === "home") { officeApi && officeApi.setPaused(false); bustApi && bustApi.setPaused(false); }
}
function sendChat() {
  if (pending) return;
  const text = $("chatText").value.trim(), imgs = attach;
  if (!text && !imgs.length) { $("chatText").focus(); return; }
  $("chatText").value = ""; growText(); attach = []; renderAtt();
  if (agentReady()) { askAgent(text, imgs); return; }
  if (imgs.length) chatNotes.push("<b>Фото не надіслано:</b> аналіз фото працює лише з підключеним AI-агентом.");
  if (text) { chatNotes.push(`<span class="muted">Ви:</span> ${esc(text)}`); mirrorSay = true; try { handleCommand(text); } finally { mirrorSay = false; } }
  renderChat();
}
$("chatSend").onclick = sendChat;
$("chatClose").onclick = closeChat;
$("chatPhoto").onclick = () => $("chatFile").click();
$("chatFile").onchange = e => { addPhotos(e.target.files); e.target.value = ""; };
$("chatAtt").onclick = e => { const b = e.target.closest("button[data-i]"); if (b) { attach.splice(+b.dataset.i, 1); renderAtt(); } };
$("chatText").addEventListener("input", growText);
$("chatText").addEventListener("keydown", e => {   // Enter — надіслати (на ПК), Shift+Enter — новий рядок
  if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer:coarse)").matches) { e.preventDefault(); sendChat(); }
});
$("chatText").addEventListener("paste", e => {
  const files = [...(e.clipboardData?.files || [])].filter(f => /^image\//.test(f.type));
  if (files.length) { e.preventDefault(); addPhotos(files); }
});
$("chatLog").addEventListener("click", e => { if (e.target.id === "chatSetup") { closeChat(); setActive("settings"); openSettings(); } });
$("chatClear").onclick = () => {
  if (!history.length && !chatNotes.length) return;
  if (!confirm("Очистити всю розмову з Властеліном?")) return;
  history = []; chatNotes = []; saveHistory(); renderChat(); toast("Розмову очищено");
};

/* ====== 3D ====== */
async function boot3D() {
  const done = () => $("loader").classList.add("done");
  try {
    const gl = document.createElement("canvas").getContext("webgl2") || document.createElement("canvas").getContext("webgl");
    if (!gl) throw new Error("no webgl");
    const [{ initOffice }, { initAssistant }] = await Promise.all([import(`./office3d.js${VER}`), import(`./assistant3d.js${VER}`)]);
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
// Порядок = порядок у меню (номер SYS.xx береться звідси). «Загальний прогрес» — завжди останній.
const SLUGS = { "Головна": "home", "Бізнес-центр": "business", "Проєкти": "projects", "Фінанси": "finance", "Медіацентр": "media",
  "Логістика": "logistics", "Ринок": "market", "Розробка гри": "game", "Бізнес": "biz", "Інвестиції": "invest", "Юридичний блок": "legal",
  "Розробка": "dev", "Комунікації": "comms", "Аналітика": "analytics", "Властелін": "brain", "Налаштування": "settings", "Загальний прогрес": "progress" };
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

/* ====== фінанси на головній: справжні дані з розділу «Фінанси» ====== */
function sparkPath(pts, w = 300, h = 60) {   // крива, масштабована між мінімумом і максимумом
  if (pts.length < 2) pts = [pts[0] || 0, pts[0] || 0];
  const lo = Math.min(...pts), hi = Math.max(...pts), span = hi - lo || 1, step = w / (pts.length - 1);
  return pts.map((v, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)} ${(h - 4 - (v - lo) / span * (h - 8)).toFixed(1)}`).join(" ");
}
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
// Початок розмови з Властеліном відкриває подовжене вікно чату (там є історія і фото).
function sendCmd() {
  const v = $("cmdInput").value.trim(); $("cmdInput").value = "";
  openChat(v); if (v) sendChat();
}
$("cmdSend").onclick = sendCmd;
$("cmdInput").onkeydown = e => { if (e.key === "Enter") sendCmd(); };
$("cmdInput").addEventListener("focus", () => { const v = $("cmdInput").value; $("cmdInput").value = ""; $("cmdInput").blur(); openChat(v); });
$("bubble").addEventListener("click", () => openChat());
$("bubble").style.cursor = "pointer"; $("bubble").title = "Відкрити чат з Властеліном";

/* ====== голос ====== */
["wave", "wave2"].forEach(id => {
  const w = $(id);
  for (let i = 0; i < 22; i++) { const b = document.createElement("i"); b.style.animationDelay = (Math.random() * 1.2).toFixed(2) + "s"; w.appendChild(b); }
});
/* Одне натискання 🎤 — слухаю. Пауза ~1.5 с після мови = «договорив» → надсилаю сам.
   Повторне натискання — надіслати одразу. «Режим розмови» — після відповіді слухаю знову. */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const SILENCE_MS = 1500, WAIT_MS = 8000, MAX_MS = 45000;
const VOICE_ERR = {
  "not-allowed": "Немає доступу до мікрофона. Дозвольте мікрофон для цього сайту в налаштуваннях браузера.",
  "service-not-allowed": "Браузер не дозволив розпізнавання мови. На iPhone перевірте: Параметри → Siri → Диктування увімкнено.",
  "language-not-supported": "Цей браузер не розпізнає українську мову.",
  "audio-capture": "Мікрофон не знайдено.",
  "network": "Немає зв'язку зі службою розпізнавання мови."
};
let rec = null, heard = "", silenceT = 0, maxT = 0;
const talkMode = () => $("chatTalk").checked;
function setListening(v) {
  ["micBtn", "chatMic"].forEach(id => $(id).classList.toggle("live", v));
  $("wave").classList.toggle("live", v); $("wave2").classList.toggle("live", v);
  $("chatwin").classList.toggle("listening", v);
  $("chatText").placeholder = v ? "Слухаю… говоріть, пауза — і я відповім" : "Напишіть Властеліну…";
  bustApi && bustApi.listen(v);
}
function stopVoice(send = true) { if (!rec) return; rec._send = send; clearTimeout(silenceT); clearTimeout(maxT); try { rec.stop(); } catch (e) {} }
function startVoice(auto = false) {
  if (auto !== true) auto = false;   // викликається і як обробник кліку (з подією)
  if (!SR) {
    openChat();
    chatNotes.push("<b>Голосовий ввід недоступний у цьому браузері.</b> На iPhone відкрийте сайт у Safari, на комп'ютері — у Chrome або Edge. Або скористайтеся кнопкою диктування 🎤 на клавіатурі телефона.");
    renderChat(); return;
  }
  if (rec) { stopVoice(true); return; }   // повторне натискання — «я договорив»
  try { speechSynthesis.cancel(); } catch (e) {}
  if (pending) return;
  openChat();
  heard = "";
  const base = $("chatText").value.trim();
  const r = rec = new SR();
  r.lang = "uk-UA"; r.interimResults = true; r.continuous = true; r._send = true;
  const finish = () => stopVoice(true);
  r.onresult = e => {
    let text = "";
    for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript + " ";
    heard = text.replace(/\s+/g, " ").trim();
    $("chatText").value = (base ? base + " " : "") + heard; growText();
    clearTimeout(silenceT); silenceT = setTimeout(finish, SILENCE_MS);
  };
  r.onerror = e => { r._err = e.error; };
  r.onend = () => {
    clearTimeout(silenceT); clearTimeout(maxT);
    if (rec === r) rec = null;
    setListening(false);
    if (r._send && heard) { sendChat(); return; }
    const msg = VOICE_ERR[r._err];
    if (msg) chatNotes.push(`<b>Голос:</b> ${msg}`);
    else if (!heard && !auto && r._err !== "aborted") chatNotes.push("<b>Не почув.</b> Натисніть 🎤 і говоріть — коли зробите паузу, я відповім.");
    renderChat();
  };
  try { r.start(); } catch (e) { rec = null; return; }
  setListening(true); say("<b>Слухаю…</b>", 0);
  silenceT = setTimeout(finish, WAIT_MS);   // якщо взагалі мовчите — зупиняюсь
  maxT = setTimeout(finish, MAX_MS);
}
$("micBtn").onclick = startVoice;
$("dVoice").onclick = startVoice;
$("chatMic").onclick = startVoice;
$("chatTalk").checked = !!store.get("vl_talk", false);
$("chatTalk").onchange = () => { store.set("vl_talk", $("chatTalk").checked); if (!$("chatTalk").checked) stopVoice(false); };

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
  else if (!$("chatwin").hidden) closeChat();
  else if ($("assistant").classList.contains("big")) toggleBig(false);
  else if (section !== "home") go("home");
});

/* ====== налаштування агента ====== */
function openSettings() {
  $("setUrl").value = agent.url || ""; $("setCode").value = agent.code || ""; $("setVoice").checked = !!agent.voice;
  fillVoiceSelect();
  $("setNote").className = "set-note"; $("setNote").textContent = "Код доступу зберігається лише в цьому браузері. Ключ Claude API на сайт не потрапляє — він лежить на сервері агента.";
  $("settings").hidden = false; $("backdrop").classList.add("show"); $("setUrl").focus();
}
function closeSettings() { $("settings").hidden = true; if (!$("assistant").classList.contains("big")) $("backdrop").classList.remove("show"); setActive(section); }
function readSettings() { agent.url = $("setUrl").value.trim(); agent.code = $("setCode").value; agent.voice = $("setVoice").checked; agent.voiceName = $("setVoiceName").value; }
$("setVoiceTest").onclick = () => {
  const keep = { voice: agent.voice, voiceName: agent.voiceName };
  agent.voice = true; agent.voiceName = $("setVoiceName").value; voiceWarned = false;
  speakOut(`Вітаю, ${CONFIG.userName}! Я Властелін. Так звучатиме мій голос.`);
  Object.assign(agent, keep);
};
$("setClose").onclick = closeSettings;
$("setTest").onclick = async () => {
  readSettings(); $("setNote").className = "set-note"; $("setNote").textContent = "Перевіряю…";
  const r = await pingAgent(); $("setNote").className = "set-note " + (r.ok ? "ok" : "bad"); $("setNote").textContent = r.msg;
};
$("setClear").onclick = () => { history = []; chatNotes = []; saveHistory(); renderChat(); toast("Розмову очищено"); };
$("setSave").onclick = async () => {
  readSettings();
  if (agent.url && !agentReady()) { $("setNote").className = "set-note bad"; $("setNote").textContent = "Адреса має починатися з https://"; return; }
  store.set("vl_agent", agent); closeSettings(); toast("Налаштування збережено");
  sync.run(true);
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
  ["AI-агент", aiOnline ? "ok" : !checked ? "" : agentReady() ? "bad" : "warn", aiOnline ? "онлайн" : !checked ? "перевірка…" : agentReady() ? "немає зв'язку" : "не налаштований"],
  ["Хмара (спільні дані)", !sync ? "" : sync.state === "ok" ? "ok" : sync.state === "bad" ? "bad" : "warn", sync ? esc(sync.msg) : "перевірка…"]
].map(([n, st, t]) => `<li><span class="dot ${st}"></span><span>${n}</span><span class="muted">${t}</span></li>`).join("");
const aiTxt = () => aiOnline ? "Онлайн" : !checked ? "…" : agentReady() ? "Немає зв'язку" : "Не налаштований";
const note = t => `<p class="sp-note">${t}</p>`;
const LOCAL_NOTE = note("Цифри обчислюються з даних офісу, спільних для всіх ваших пристроїв, і оновлюються автоматично.");
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
/* ====== робочий простір розділу: технічні завдання (ТЗ) і власні вікна ======
   vl_ws = { [section]: { tasks: [{title, desc, status, at}], wins: [{title, text, at}] } } */
let ws = store.get("vl_ws", {});
if (!ws || typeof ws !== "object" || Array.isArray(ws)) ws = {};
const wsOf = s => (ws[s] = ws[s] && Array.isArray(ws[s].tasks) && Array.isArray(ws[s].wins) ? ws[s] : { tasks: [], wins: [] });
const saveWs = () => { store.set("vl_ws", ws); renderHomeFin(); };
const TASK_ST = { new: "Нове", work: "В роботі", done: "Готово" };
const TASK_NEXT = { new: "work", work: "done", done: "new" };
let spTab = "main";
function tabsBar(s) {
  const w = wsOf(s), open = w.tasks.filter(t => t.status !== "done").length;
  return `<div class="sp-tabs" role="tablist">${[["main", "Огляд", ""], ["tasks", "Технічні завдання", open], ["wins", "Вікна", w.wins.length]]
    .map(([k, t, n]) => `<button role="tab" aria-selected="${spTab === k}" class="${spTab === k ? "on" : ""}" data-act="tab" data-k="${k}">${t}${n !== "" ? ` <i>${n}</i>` : ""}</button>`).join("")}</div>`;
}
function tasksView(s) {
  const w = wsOf(s);
  return `<section class="sp-box"><h3>Нове технічне завдання</h3>
    <div class="sp-form sp-col"><input id="spTTitle" placeholder="Назва завдання" maxlength="100" data-enter="t-add" aria-label="Назва завдання">
    <textarea id="spTDesc" rows="3" maxlength="2000" placeholder="Опис: що зробити і як зрозуміти, що готово" aria-label="Опис завдання"></textarea>
    <button class="btn-gold" data-act="t-add">+ Додати завдання</button></div></section>
    <ul class="sp-tasks">${w.tasks.map((t, i) => `<li class="st-${esc(t.status)}"><div class="tm"><b>${esc(t.title)}</b>${t.desc ? `<p>${esc(t.desc)}</p>` : ""}<small>${new Date(t.at).toLocaleDateString("uk-UA")}</small></div>
      <button class="sp-st" data-act="t-st" data-i="${i}" title="Змінити статус">${TASK_ST[t.status] || TASK_ST.new}</button>
      <button class="sp-x" data-act="t-del" data-i="${i}" aria-label="Видалити завдання ${esc(t.title)}">×</button></li>`).join("") || `<li class="empty">Технічних завдань поки немає — додайте перше.</li>`}</ul>
    ${note("Статус змінюється натисканням: Нове → В роботі → Готово. Завдання спільні для всіх ваших пристроїв; пізніше їх зможуть брати в роботу найняті агенти.")}`;
}
function winsView(s) {
  const w = wsOf(s);
  return `<section class="sp-box"><h3>Нове вікно</h3>
    <div class="sp-form sp-col"><input id="spWTitle" placeholder="Назва вікна" maxlength="60" data-enter="w-add" aria-label="Назва вікна">
    <textarea id="spWText" rows="3" maxlength="2000" placeholder="Вміст: нотатки, посилання, контакти, ідеї" aria-label="Вміст вікна"></textarea>
    <button class="btn-gold" data-act="w-add">+ Додати вікно</button></div></section>
    <div class="sp-wins">${w.wins.map((x, i) => `<article class="sp-win"><header><b>${esc(x.title)}</b><button class="sp-x" data-act="w-del" data-i="${i}" aria-label="Видалити вікно ${esc(x.title)}">×</button></header><p>${esc(x.text || "")}</p></article>`).join("") || `<p class="empty">Вікон поки немає — додайте перше.</p>`}</div>`;
}
function renderPanel() {
  if (!VIEWS[section]) return;
  const v = VIEWS[section];
  if (v.tabs) { $("spBody").innerHTML = v.render(); return; }   // розділ із власними вкладками
  $("spBody").innerHTML = tabsBar(section) + (spTab === "tasks" ? tasksView(section) : spTab === "wins" ? winsView(section) : v.render());
}

/* ====== «Властелін»: пропозиції (крок 4) і довготривала пам'ять (крок 2) — дані на сервері ====== */
const brain = { memory: null, proposals: null, max: 200, err: "", at: 0, busy: false };
const SECTION_NAMES = { business: "Бізнес-центр", projects: "Проєкти", finance: "Фінанси", media: "Медіацентр", logistics: "Логістика", market: "Ринок", game: "Розробка гри", biz: "Бізнес", invest: "Інвестиції", legal: "Юридичний блок", dev: "Розробка", comms: "Комунікації", analytics: "Аналітика" };
const MEM_CAT = { fact: "Факт", preference: "Вподобання", decision: "Рішення", goal: "Ціль" };
async function brainApi(path, method = "GET", body) {
  const r = await fetch(agent.url.replace(/\/+$/, "") + path, {
    method, headers: { "Content-Type": "application/json", "X-Access-Code": agent.code || "" },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Помилка ${r.status}`);
  return j;
}
async function loadBrain(force = false) {
  // Викликається й із render(): тут не можна синхронно перемальовувати панель (була б рекурсія).
  if (!agentReady()) { brain.err = "Підключіть AI-агента в «Налаштуваннях» — пам'ять і пропозиції зберігаються на сервері."; return; }
  if (brain.busy || (!force && Date.now() - brain.at < 30e3)) return;
  brain.busy = true; brain.at = Date.now();   // і після помилки — не частіше ніж раз на 30 с
  try {
    const [m, p] = await Promise.all([brainApi("/memory"), brainApi("/proposals")]);
    brain.memory = m.memory || []; brain.max = m.max || 200; brain.proposals = p.proposals || []; brain.err = "";
  } catch (e) { brain.err = e.message || "Немає зв'язку з сервером"; }
  finally { brain.busy = false; refreshPanel("brain"); markProposals(); }
}
function markProposals() {   // лічильник нових пропозицій на кнопці меню
  const code = document.querySelector('.menu button[data-s="Властелін"] code'); if (!code) return;
  const n = (brain.proposals || []).filter(p => p.status === "new").length;
  code.dataset.n = code.dataset.n || code.textContent;
  code.textContent = n ? `${n} нов.` : code.dataset.n; code.classList.toggle("hot", n > 0);
}
function proposalsView() {
  if (!brain.proposals) return `<p class="empty">${brain.err ? esc(brain.err) : "Завантаження…"}</p>`;
  const open = brain.proposals.filter(p => p.status === "new"), past = brain.proposals.filter(p => p.status !== "new").slice(0, 10);
  const item = (p, act) => `<li class="pr-${esc(p.status)}"><div class="tm"><b>${esc(p.title)}</b><p>${esc(p.details)}</p>
      <small>${esc(SECTION_NAMES[p.section] || p.section)} · вартість: ${esc(p.cost)} · ${new Date(p.created).toLocaleDateString("uk-UA")}</small></div>
      ${act ? `<div class="pr-btns"><button class="btn-gold" data-act="pr-ok" data-i="${p.id}">Схвалити</button><button class="btn-ghost" data-act="pr-no" data-i="${p.id}">Відхилити</button></div>`
        : `<span class="sp-st">${p.status === "approved" ? "Схвалено" : "Відхилено"}</span>`}</li>`;
  return `<div class="sp-ask"><button class="btn-gold" data-act="brain-ask">◈ Аналіз і пропозиції</button>
      <span>Властелін перегляне проєкти, задачі, пам'ять і GitHub та запропонує до 3 покращень (розумна модель, ≈$0.01–0.03).</span></div>
    <section class="sp-box"><h3>Чекають рішення · ${open.length}</h3>
      <ul class="sp-tasks sp-props">${open.map(p => item(p, true)).join("") || `<li class="empty">Нових пропозицій немає. Попросіть у чаті: «запропонуй, що покращити».</li>`}</ul></section>
    ${past.length ? `<section class="sp-box"><h3>Історія рішень</h3><ul class="sp-tasks sp-props">${past.map(p => item(p, false)).join("")}</ul></section>` : ""}
    ${note("Властелін лише пропонує. Схвалена пропозиція стає технічним завданням у своєму розділі (вкладка «Технічні завдання»). Пізніше (крок 5) схвалені завдання зможуть виконувати найняті агенти.")}`;
}
function memoryView() {
  if (!brain.memory) return `<p class="empty">${brain.err ? esc(brain.err) : "Завантаження…"}</p>`;
  return `<section class="sp-box"><h3>Додати запис вручну</h3>
      <div class="sp-form sp-col"><textarea id="spMText" rows="2" maxlength="300" placeholder="Напр.: Звіти мені потрібні щопонеділка о 9:00" aria-label="Новий запис пам'яті"></textarea>
      <div class="sp-form"><select id="spMCat" aria-label="Тип запису">${Object.entries(MEM_CAT).map(([k, t]) => `<option value="${k}">${t}</option>`).join("")}</select>
      <button class="btn-gold" data-act="m-add">+ Запам'ятати</button></div></div></section>
    <section class="sp-box"><h3>Що пам'ятає Властелін · ${brain.memory.length} з ${brain.max}</h3>
      <ul class="sp-tasks sp-mem">${brain.memory.map(m => `<li><div class="tm"><b>${esc(m.text)}</b><small>№${m.id} · ${esc(MEM_CAT[m.cat] || m.cat)} · ${new Date(m.updated).toLocaleDateString("uk-UA")}</small></div>
        <button class="sp-st" data-act="m-edit" data-i="${m.id}" title="Змінити">Змінити</button>
        <button class="sp-x" data-act="m-del" data-i="${m.id}" aria-label="Видалити запис №${m.id}">×</button></li>`).join("") || `<li class="empty">Пам'ять порожня. Скажіть у чаті: «запам'ятай, що…»</li>`}</ul></section>
    ${note("Пам'ять спільна для всіх ваших пристроїв. Властелін бачить ці записи в кожній розмові. Секрети (ключі, паролі) сюди не записуються.")}`;
}
VIEWS.brain = { ico: "⬡", title: "ВЛАСТЕЛІН · ПРОПОЗИЦІЇ І ПАМ'ЯТЬ", tabs: true, render() {
  loadBrain();
  const tab = spTab === "mem" ? "mem" : "props";
  const n = (brain.proposals || []).filter(p => p.status === "new").length;
  return `<div class="sp-tabs" role="tablist">${[["props", "Пропозиції", n || ""], ["mem", "Пам'ять", brain.memory ? brain.memory.length : ""]]
    .map(([k, t, c]) => `<button role="tab" aria-selected="${tab === k}" class="${tab === k ? "on" : ""}" data-act="tab" data-k="${k}">${t}${c !== "" ? ` <i>${c}</i>` : ""}</button>`).join("")}</div>`
    + (tab === "mem" ? memoryView() : proposalsView());
} };
async function brainDo(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); } catch (e) { toast(e.message || "Помилка"); }
  await loadBrain(true);
}

/* ====== розділи з власними даними ======
   Дані кожного розділу лежать у vl_ws[section][list] → синхронізуються між пристроями разом із ТЗ і вікнами.
   COL описує поля форми, статуси (натискання перемикає по колу) і числові поля, які можна змінити. */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const toNum = v => { const n = parseFloat(String(v ?? "").replace(/[\s ]/g, "").replace(",", ".")); return Number.isFinite(n) ? n : 0; };
const money = (n, cur = "") => (Math.round(n * 100) / 100).toLocaleString("uk-UA", { maximumFractionDigits: 2 }) + (cur ? " " + cur : "");
const todayISO = () => new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const fmtDate = d => d ? new Date(d + "T00:00").toLocaleDateString("uk-UA") : "";
const daysTo = d => d ? Math.round((new Date(d + "T00:00") - new Date(todayISO() + "T00:00")) / 864e5) : null;
const share = (a, b) => b ? Math.round(a / b * 100) : 0;
const INV_KINDS = [["crypto", "Криптовалюта"], ["gold", "Золото"], ["stocks", "Акції / фонди"], ["realty", "Нерухомість"], ["business", "Бізнес"], ["other", "Інше"]];
const COL = {
  finance: { list: "ops", add: "+ Додати операцію", fields: [
    { k: "type", label: "Тип", type: "select", opts: [["in", "Дохід"], ["out", "Витрата"]] },
    { k: "amount", label: "Сума", type: "number", req: true },
    { k: "title", label: "Категорія або опис (напр. Реклама)" },
    { k: "date", label: "Дата", type: "date", def: todayISO }],
    edit: ["amount"],
    line: x => ({ title: `${x.type === "in" ? "+" : "−"} ${money(toNum(x.amount), finCur())} · ${x.title || (x.type === "in" ? "Дохід" : "Витрата")}`, meta: fmtDate(x.date), cls: x.type === "in" ? "op-in" : "op-out" }) },
  media: { list: "videos", add: "+ Додати відео", fields: [
    { k: "title", label: "Назва відео або тема", req: true },
    { k: "date", label: "Дата публікації", type: "date" },
    { k: "link", label: "Посилання на YouTube (необов'язково)", type: "url" }],
    st: [["idea", "Ідея"], ["script", "Сценарій"], ["shoot", "Зйомка"], ["edit", "Монтаж"], ["ready", "Готове"], ["pub", "Опубліковано"]] },
  logistics: { list: "ships", add: "+ Додати відправлення", fields: [
    { k: "title", label: "Що відправляємо", req: true },
    { k: "route", label: "Маршрут: звідки → куди" },
    { k: "carrier", label: "Перевізник (Нова пошта, DHL…)" },
    { k: "ttn", label: "Номер ТТН / трек-номер" },
    { k: "date", label: "Очікувана дата", type: "date" }],
    st: [["plan", "Планується"], ["transit", "В дорозі"], ["done", "Доставлено"], ["problem", "Проблема"]],
    line: x => {
      const np = /нов|nova|np/i.test(x.carrier || "") && x.ttn;
      return { title: x.title, meta: [x.route, x.carrier, x.ttn && "ТТН " + x.ttn, x.date && "очікується " + fmtDate(x.date)].filter(Boolean).join(" · "),
        extra: np ? ` <a href="https://novaposhta.ua/tracking/?cargo_number=${encodeURIComponent(x.ttn)}" target="_blank" rel="noopener">відстежити ↗</a>` : "" };
    } },
  market: { list: "alerts", add: "+ Додати сповіщення", fields: [
    { k: "price", label: "Рівень ціни XAU/USDT", type: "number", req: true },
    { k: "dir", label: "Коли", type: "select", opts: [["above", "Ціна вище рівня"], ["below", "Ціна нижче рівня"]] }],
    line: x => ({ title: `XAU/USDT ${x.dir === "below" ? "≤" : "≥"} ${money(toNum(x.price))}`, meta: x.hit ? `спрацювало ${new Date(x.hit).toLocaleString("uk-UA")}` : "чекає", cls: x.hit ? "cs-done" : "" }) },
  game: { list: "backlog", add: "+ Додати в беклог", fields: [
    { k: "title", label: "Фіча, баг або задача", req: true },
    { k: "kind", label: "Тип", type: "select", opts: [["feature", "Фіча"], ["bug", "Баг"], ["art", "Графіка"], ["sound", "Звук"], ["level", "Рівень"]] }],
    st: [["todo", "Заплановано"], ["work", "В роботі"], ["done", "Готово"]] },
  biz: { list: "items", add: "+ Додати бізнес", fields: [
    { k: "title", label: "Назва бізнесу або напряму", req: true },
    { k: "niche", label: "Ніша" },
    { k: "rev", label: "Дохід за місяць", type: "number" },
    { k: "goal", label: "Ціль на місяць", type: "number" }],
    st: [["idea", "Ідея"], ["launch", "Запуск"], ["work", "Працює"], ["scale", "Масштабування"], ["pause", "Пауза"]], edit: ["rev", "goal"],
    line: x => ({ title: x.title, meta: [x.niche, `дохід ${money(toNum(x.rev), finCur())} з ${money(toNum(x.goal), finCur())} (${share(toNum(x.rev), toNum(x.goal))}%)`].filter(Boolean).join(" · ") }) },
  invest: { list: "assets", add: "+ Додати актив", fields: [
    { k: "title", label: "Актив (Золото, BTC, акції…)", req: true },
    { k: "kind", label: "Тип", type: "select", opts: INV_KINDS },
    { k: "inv", label: "Вкладено", type: "number", req: true },
    { k: "val", label: "Поточна вартість", type: "number" }], edit: ["inv", "val"],
    line: x => {
      const inv = toNum(x.inv), val = x.val === "" || x.val == null ? inv : toNum(x.val), pl = val - inv;
      return { title: x.title, meta: `${(INV_KINDS.find(k => k[0] === x.kind) || [, "Інше"])[1]} · вкладено ${money(inv, finCur())} → зараз ${money(val, finCur())} (${pl >= 0 ? "+" : "−"}${money(Math.abs(pl))}, ${pl >= 0 ? "+" : ""}${inv ? (pl / inv * 100).toFixed(1) : "0"}%)`, cls: pl >= 0 ? "op-in" : "op-out" };
    } },
  legal: { list: "docs", add: "+ Додати документ", fields: [
    { k: "title", label: "Документ (договір, ліцензія…)", req: true },
    { k: "kind", label: "Тип", type: "select", opts: [["contract", "Договір"], ["license", "Ліцензія / дозвіл"], ["company", "Установчі документи"], ["ip", "Торгова марка / IP"], ["other", "Інше"]] },
    { k: "party", label: "Контрагент або орган" },
    { k: "date", label: "Діє до", type: "date" }],
    st: [["draft", "Чернетка"], ["sign", "На підписі"], ["active", "Діє"], ["closed", "Закрито"]],
    line: x => {
      const d = daysTo(x.date), live = x.st !== "closed";
      const when = x.date ? (d < 0 ? `термін минув ${fmtDate(x.date)}` : d === 0 ? "закінчується сьогодні" : `діє до ${fmtDate(x.date)} (${d} дн.)`) : "";
      const f = COL.legal.fields[1];
      return { title: x.title, meta: [(f.opts.find(o => o[0] === x.kind) || [, ""])[1], x.party, when].filter(Boolean).join(" · "),
        cls: live && d !== null && d < 0 ? "lg-bad" : live && d !== null && d <= 30 ? "lg-warn" : "cs-" + (x.st || "") };
    } }
};
const colList = s => { const w = wsOf(s), c = COL[s]; return Array.isArray(w[c.list]) ? w[c.list] : (w[c.list] = []); };
const finCur = () => (ws.finance && ws.finance.cur) || "₴";
function colForm(s, title) {
  const c = COL[s];
  return `<section class="sp-box"><h3>${title || c.add.replace("+ ", "")}</h3><div class="sp-form sp-grid">${c.fields.map(f => f.type === "select"
      ? `<select id="cf_${f.k}" aria-label="${f.label}" title="${f.label}">${f.opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select>`
      : `<input id="cf_${f.k}" type="${f.type === "date" ? "date" : f.type === "url" ? "url" : "text"}"${f.type === "number" ? ' inputmode="decimal"' : ""} placeholder="${f.label}${f.req ? " *" : ""}" aria-label="${f.label}" title="${f.label}" maxlength="${f.type === "url" ? 300 : 120}" value="${f.def ? f.def() : ""}" data-enter="c-add">`).join("")}
    <button class="btn-gold" data-act="c-add" data-k="${s}">${c.add}</button></div></section>`;
}
function colItems(s, items, empty) {
  const c = COL[s];
  return `<ul class="sp-tasks sp-items">${items.map(x => {
    const l = c.line ? c.line(x) : { title: x.title, meta: c.fields.filter(f => f.k !== "title" && f.type !== "url" && x[f.k] !== "" && x[f.k] != null)
      .map(f => f.type === "select" ? (f.opts.find(o => o[0] === x[f.k]) || [, x[f.k]])[1] : f.type === "date" ? `${f.label.toLowerCase()}: ${fmtDate(x[f.k])}` : x[f.k]).join(" · ") };
    const link = x.link && /^https?:\/\//i.test(x.link) ? ` <a href="${esc(x.link)}" target="_blank" rel="noopener">відкрити ↗</a>` : "";
    const st = c.st ? c.st.find(o => o[0] === x.st) || c.st[0] : null;
    const editBtn = c.edit ? `<button class="sp-link" data-act="c-edit" data-id="${esc(x.id)}">змінити суми</button>` : "";
    return `<li class="${esc(l.cls || (st ? "cs-" + st[0] : ""))}"><div class="tm"><b>${esc(l.title)}</b><small>${esc(l.meta || "")}${link}${l.extra || ""}${st ? editBtn : ""}</small></div>
      ${st ? `<button class="sp-st" data-act="c-st" data-id="${esc(x.id)}" title="Змінити статус">${st[1]}</button>` : c.edit ? `<button class="sp-st" data-act="c-edit" data-id="${esc(x.id)}">Змінити</button>` : "<span></span>"}
      <button class="sp-x" data-act="c-del" data-id="${esc(x.id)}" aria-label="Видалити «${esc(l.title)}»">×</button></li>`;
  }).join("") || `<li class="empty">${empty}</li>`}</ul>`;
}
const askBtn = (label, q, hint = "") => `<div class="sp-ask"><button class="btn-ghost" data-act="ask" data-q="${esc(q)}">◈ ${label}</button>${hint ? `<span>${hint}</span>` : ""}</div>`;
const countBy = (items, key) => items.reduce((m, x) => (m[x[key]] = (m[x[key]] || 0) + 1, m), {});
const stBars = (s, items) => { const c = COL[s], n = countBy(items, "st"); return bars(c.st.map(([k, t]) => [t, share(n[k] || 0, items.length), n[k] || 0])); };
const SYNC_NOTE = note("Дані спільні для всіх ваших пристроїв: зберігаються на сервері офісу й синхронізуються автоматично.");

/* --- Фінанси --- */
function finStats() {
  const ops = colList("finance"), m = todayISO().slice(0, 7), cats = {};
  let bal = 0, inM = 0, outM = 0;
  for (const o of ops) {
    const a = toNum(o.amount), inc = o.type === "in";
    bal += inc ? a : -a;
    if ((o.date || "").startsWith(m)) inc ? inM += a : outM += a;
    if (!inc) cats[o.title || "Інше"] = (cats[o.title || "Інше"] || 0) + a;
  }
  const series = []; let run = 0;
  for (const o of ops.slice().sort((a, b) => (a.date || "").localeCompare(b.date || "") || a.at - b.at)) series.push(run += (o.type === "in" ? 1 : -1) * toNum(o.amount));
  return { ops, bal, inM, outM, cats, series: [0, ...series].slice(-30) };
}
function renderHomeFin() {
  const s = finStats(), cur = finCur(), net = s.inM - s.outM;
  $("balance").textContent = s.ops.length ? money(s.bal, cur) : "—";
  $("finChg").textContent = s.ops.length ? `${net >= 0 ? "↗ +" : "↘ −"}${money(Math.abs(net), cur)} за місяць` : "Додайте першу операцію";
  $("finChg").classList.toggle("down", net < 0);
  $("finCode").textContent = s.ops.length ? `${s.ops.length} ОП.` : "ПОРОЖНЬО";
  const line = sparkPath(s.series);
  $("sparkLine").setAttribute("d", line); $("sparkArea").setAttribute("d", line + " L300 60 L0 60 Z");
}
VIEWS.finance = { ico: "⬡", title: "ФІНАНСИ", render() {
  const s = finStats(), cur = finCur(), line = sparkPath(s.series, 600, 140);
  const cats = Object.entries(s.cats).sort((a, b) => b[1] - a[1]).slice(0, 8), maxCat = cats.length ? cats[0][1] : 1;
  const ops = s.ops.slice().sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.at - a.at);
  return `<div class="sp-tiles">${tile("Баланс", money(s.bal, cur))}${tile("Доходи за місяць", `<span class="up">+${money(s.inM)}</span>`)}${tile("Витрати за місяць", `<span class="dn">−${money(s.outM)}</span>`)}${tile("Операцій", s.ops.length)}</div>
    <div class="sp-cur">Валюта: ${["₴", "$", "€", "USDT"].map(c => `<button class="${c === cur ? "on" : ""}" data-act="fin-cur" data-k="${c}">${c}</button>`).join("")}</div>
    ${colForm("finance", "Нова операція")}
    <div class="sp-cols">
      <section class="sp-box"><h3>Динаміка балансу</h3>${s.ops.length > 1 ? `<svg class="sp-spark" viewBox="0 0 600 140" preserveAspectRatio="none" aria-hidden="true"><path d="${line} L600 140 L0 140 Z" fill="url(#sparkFill)"/><path d="${line}" fill="none" stroke="#ffd88a" stroke-width="2.5" vector-effect="non-scaling-stroke"/></svg>` : `<p class="empty">Графік з'явиться після двох операцій.</p>`}</section>
      <section class="sp-box"><h3>Витрати за категоріями</h3>${cats.length ? bars(cats.map(([n, v]) => [n, v / maxCat * 100, money(v)]), "gold") : `<p class="empty">Витрат ще немає.</p>`}</section>
    </div>
    <section class="sp-box"><h3>Операції</h3>${colItems("finance", ops, "Операцій поки немає — додайте дохід або витрату вище.")}</section>
    ${askBtn("Аналіз фінансів від Властеліна", "Проаналізуй мої фінанси (баланс, доходи, витрати за категоріями) і дай 3 поради, як покращити.", "Розумна модель, ≈$0.01–0.03.")}${SYNC_NOTE}`;
} };

/* --- Медіацентр (YouTube) --- */
VIEWS.media = { ico: "▶", title: "МЕДІАЦЕНТР · YOUTUBE", render() {
  const v = colList("media"), n = countBy(v, "st"), inWork = v.length - (n.pub || 0) - (n.idea || 0);
  const next = v.filter(x => x.st !== "pub" && x.date).sort((a, b) => a.date.localeCompare(b.date))[0];
  return `<div class="sp-tiles">${tile("Відео в плані", v.length)}${tile("Ідей", n.idea || 0)}${tile("У виробництві", inWork)}${tile("Опубліковано", n.pub || 0)}</div>
    <div class="sp-actions"><a class="btn-ghost" href="https://studio.youtube.com" target="_blank" rel="noopener">YouTube Studio ↗</a><a class="btn-ghost" href="https://www.youtube.com/upload" target="_blank" rel="noopener">Завантажити відео ↗</a></div>
    ${next ? note(`Найближча публікація: «${esc(next.title)}» — ${fmtDate(next.date)}.`) : ""}
    ${colForm("media", "Нове відео")}
    <div class="sp-cols">
      <section class="sp-box"><h3>Відео</h3>${colItems("media", v, "Відео поки немає. Додайте ідею — далі натискайте статус: Ідея → Сценарій → Зйомка → Монтаж → Готове → Опубліковано.")}</section>
      <section class="sp-box"><h3>Конвеєр виробництва</h3>${stBars("media", v)}</section>
    </div>
    ${askBtn("Ідеї для відео від Властеліна", "Запропонуй 5 ідей відео для мого YouTube-каналу на основі моїх проєктів і бізнесу: назва, гачок у перші 10 секунд, коротка структура.")}${SYNC_NOTE}`;
} };

/* --- Логістика --- */
VIEWS.logistics = { ico: "⇄", title: "ЛОГІСТИКА", render() {
  const v = colList("logistics"), n = countBy(v, "st");
  const order = { problem: 0, transit: 1, plan: 2, done: 3 };
  const list = v.slice().sort((a, b) => (order[a.st] ?? 9) - (order[b.st] ?? 9) || (a.date || "9").localeCompare(b.date || "9"));
  return `<div class="sp-tiles">${tile("Планується", n.plan || 0)}${tile("В дорозі", n.transit || 0)}${tile("Доставлено", n.done || 0)}${tile("Проблеми", n.problem ? `<span class="dn">${n.problem}</span>` : 0)}</div>
    ${colForm("logistics", "Нове відправлення")}
    <section class="sp-box"><h3>Відправлення</h3>${colItems("logistics", list, "Відправлень поки немає. Статус змінюйте натисканням: Планується → В дорозі → Доставлено → Проблема.")}</section>
    ${note("Для Нової пошти з номером ТТН з'являється посилання «відстежити».")}${SYNC_NOTE}`;
} };

/* --- Ринок: XAU/USDT --- */
const market = { p: null, kl: null, err: "", at: 0, src: "", time: null };
async function getJson(u) { const r = await fetch(u); if (!r.ok) throw new Error(r.status); return r.json(); }
async function loadMarket(force = false) {
  if (!force && Date.now() - market.at < 15e3) return;
  market.at = Date.now();
  try {
    try {
      const [t, k] = await Promise.all([getJson("https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=XAUUSDT"), getJson("https://fapi.binance.com/fapi/v1/klines?symbol=XAUUSDT&interval=1h&limit=48")]);
      market.p = { last: +t.lastPrice, chg: +t.priceChangePercent, hi: +t.highPrice, lo: +t.lowPrice, vol: +t.quoteVolume };
      market.kl = k.map(r => +r[4]); market.src = "Binance Futures";
    } catch (e) {
      const [t, k] = await Promise.all([getJson("https://api.bybit.com/v5/market/tickers?category=linear&symbol=XAUUSDT"), getJson("https://api.bybit.com/v5/market/kline?category=linear&symbol=XAUUSDT&interval=60&limit=48")]);
      const x = t.result.list[0];
      market.p = { last: +x.lastPrice, chg: +x.price24hPcnt * 100, hi: +x.highPrice24h, lo: +x.lowPrice24h, vol: +x.turnover24h };
      market.kl = k.result.list.map(r => +r[4]).reverse(); market.src = "Bybit";
    }
    if (!Number.isFinite(market.p.last)) throw new Error("bad data");
    market.err = ""; market.time = new Date();
    checkAlerts();
  } catch (e) { market.err = "Не вдалося отримати ціну з біржі. Перевірте інтернет — спробую ще раз за 20 с."; }
  refreshPanel("market");
}
function checkAlerts() {
  const p = market.p && market.p.last; if (!p || !ws.market) return;
  let hit = false;
  for (const a of colList("market")) {
    if (a.hit) continue;
    if ((a.dir === "below" && p <= toNum(a.price)) || (a.dir !== "below" && p >= toNum(a.price))) {
      a.hit = Date.now(); hit = true;
      const msg = `XAU/USDT ${a.dir === "below" ? "опустився до" : "досяг"} ${money(toNum(a.price))} (зараз ${money(p)})`;
      toast("🔔 " + msg); say(`<b>Сповіщення ринку</b><br>${esc(msg)}`);
    }
  }
  if (hit) { saveWs(); refreshPanel("market"); }
}
/* --- Агент «Трейдер XAU»: паперова торгівля в хмарі (воркер, щохвилини) --- */
const trader = { d: null, err: "", at: 0, busy: false, cfg: false };
async function loadTrader(force = false) {
  if (!agentReady()) { trader.err = "Підключіть AI-агента в «Налаштуваннях» — трейдер працює на сервері."; return; }
  if (trader.busy || (!force && Date.now() - trader.at < 15e3)) return;
  trader.busy = true; trader.at = Date.now();
  try { trader.d = await brainApi("/trader"); trader.err = ""; } catch (e) { trader.err = e.message || "Немає зв'язку з сервером"; }
  finally { trader.busy = false; refreshPanel("market"); }
}
const TR_CFG = [["risk", "Ризик на угоду, %"], ["rr", "Ціль, R (прибуток/ризик)"], ["minRR", "Мін. R до рівня-цілі"], ["bigLot", "Велика угода від, oz"],
  ["imbRatio", "Імбаланс, разів"], ["stack", "Стек імбалансів, рівнів"], ["tick", "Крок футпрінта, $"], ["bias", "Поріг ухилу (0–0.9)"], ["tolAtr", "Допуск до рівня, ATR"], ["fee", "Комісія, % за сторону"], ["start", "Стартовий баланс, USDT"]];
const pm = (n, d = 2) => (n > 0 ? "+" : "") + (+n).toFixed(d);
const biasTxt = b => (b === "long" ? '<span class="up">▲ лонг</span>' : b === "short" ? '<span class="dn">▼ шорт</span>' : '<span class="muted">◆ флет</span>');
function traderBlock() {
  loadTrader();
  const d = trader.d;
  if (!d) return `<section class="sp-box tr"><h3>Агент «Трейдер XAU»</h3><p class="empty">${esc(trader.err || "Завантаження…")}</p></section>`;
  const s = d.stats, a = d.an, on = d.cfg.on, ago = d.run ? Math.max(0, Math.round((Date.now() - d.run) / 1000)) : null, live = ago !== null && ago < 180;
  const eq = (d.eq || []).map(e => e.b), line = eq.length > 1 ? sparkPath(eq, 600, 110) : "";
  const p = d.pos;
  const head = `<p class="tr-st"><i class="tr-dot ${live && !d.err ? (on ? "ok" : "pause") : "bad"}"></i>${on ? "Торгує на <b>паперовому</b> рахунку" : "На паузі"} · ${ago === null ? "ще не запускався (до 1 хв)" : `аналіз ${ago < 90 ? ago + " с" : Math.round(ago / 60) + " хв"} тому`}${d.src ? " · " + esc(d.src) : ""}${d.err ? ` · <span class="dn">${esc(d.err)}</span>` : ""}</p>`;
  const tiles = `<div class="sp-tiles">${tile("Баланс (паперовий)", money(d.bal) + " $", `старт ${money(d.cfg.start)} $`)}${tile("Прибуток / збиток", `<span class="${s.pnl >= 0 ? "up" : "dn"}">${pm(s.pnl)} $</span>`, pm(s.pnlPct) + "%")}${tile("Угод", s.n, `виграшних ${s.winRate}%`)}${tile("Profit factor", s.pf === null ? "∞" : s.pf, `середнє ${pm(s.avgR)}R`)}${tile("Макс. просідання", s.dd + "%", `найкраща ${pm(s.best)} · найгірша ${pm(s.worst)}`)}</div>`;
  const pos = p ? `<section class="sp-box tr-pos ${p.dir > 0 ? "long" : "short"}"><h3>Відкрита позиція: ${p.dir > 0 ? "ЛОНГ ▲" : "ШОРТ ▼"} ${p.qty} oz</h3>
      <p>Вхід <b>${money(p.entry)}</b> · стоп <b class="dn">${money(p.sl)}</b> · ціль <b class="up">${money(p.tp)}</b> · зараз ${a ? money(a.price) : "—"} · P/L <b class="${p.upnl >= 0 ? "up" : "dn"}">${pm(p.upnl)} $</b></p>
      <p class="sp-note">${esc(p.why)}</p><div class="sp-actions"><button class="btn-ghost" data-act="tr-close">Закрити позицію зараз</button></div></section>` : "";
  const an = a ? `<section class="sp-box"><h3>Аналіз зверху вниз · 4H → 5M</h3>
      <p class="tr-bias">Загальний ухил старших ТФ (4H–30M): <b class="${a.bias >= d.cfg.bias ? "up" : a.bias <= -d.cfg.bias ? "dn" : ""}">${pm(a.bias)}</b> → ${a.bias >= d.cfg.bias ? "шукаємо лонги від підтримки" : a.bias <= -d.cfg.bias ? "шукаємо шорти від опору" : "нейтрально, не торгуємо"}
        <span class="tr-meter"><i style="left:${(50 + a.bias * 50).toFixed(1)}%"></i></span></p>
      <div class="tr-scroll"><table class="tr-tab"><thead><tr><th>ТФ</th><th>Ухил</th><th>VWAP</th><th>POC</th><th>Value Area</th><th>CVD</th><th>HVN / LVN</th></tr></thead><tbody>
      ${a.tfs.map(t => `<tr${["5m", "15m"].includes(t.tf) ? ' class="main"' : ""}><td><b>${t.tf.toUpperCase()}</b></td><td>${biasTxt(t.bias)}</td><td>${money(t.vwap)}</td><td>${money(t.poc)}</td><td>${money(t.val)}–${money(t.vah)}</td>
        <td class="${t.cvd >= 0 ? "up" : "dn"}">${pm(t.cvd, 0)}${t.div ? ` <small>${t.div === "bull" ? "бич. див." : "ведм. див."}</small>` : ""}</td><td><small>${t.hvn.map(x => money(x)).join(", ") || "—"} / ${t.lvn.map(x => money(x)).join(", ") || "—"}</small></td></tr>`).join("")}
      </tbody></table></div>
      <p class="sp-note">Ціна ${money(a.price)} · VWAP дня ${money(a.vDay)} · VWAP тижня ${money(a.vWeek)} · ATR 5M ${a.atr5}${a.est ? " · ⚠ запасне джерело: дельта наближена" : ""}. Основна торгівля — 5M і 15M (виділено).</p></section>
    <div class="sp-cols">
      <section class="sp-box"><h3>Ключові рівні</h3><ul class="tr-lv">${a.levels.slice().reverse().map(l => `<li class="${Math.abs(l.p - a.price) <= a.atr5 ? "near" : ""}${l.p > a.price ? " above" : ""}"><span>${esc(l.n)}</span><b>${money(l.p)}</b></li>`).join("")}</ul></section>
      <section class="sp-box"><h3>Ордер флов · остання 5M</h3>${a.flow ? `<p>Дельта <b class="${a.flow.d >= 0 ? "up" : "dn"}">${pm(a.flow.d, 1)}</b> oz · обсяг ${a.flow.v} oz · угод ${a.flow.n}</p>
        <p>Стек імбалансів: покупці <b class="up">${a.flow.buyStack}</b>${a.flow.buyAt ? ` (до ${money(a.flow.buyAt)})` : ""} · продавці <b class="dn">${a.flow.sellStack}</b>${a.flow.sellAt ? ` (до ${money(a.flow.sellAt)})` : ""}</p>` : `<p class="empty">Футпрінт збирається…</p>`}
        <h3 class="tr-sub">Великі угоди ≥ ${d.cfg.bigLot} oz</h3>${d.big.length ? `<ul class="tr-big">${d.big.slice(0, 8).map(b => `<li><span>${new Date(b.t).toLocaleTimeString("uk-UA")}</span><b class="${b.buy ? "up" : "dn"}">${b.buy ? "купівля" : "продаж"} ${b.q}</b><span>${money(b.p)}</span></li>`).join("")}</ul>` : `<p class="empty">Поки немає</p>`}</section>
    </div>` : "";
  const trades = `<section class="sp-box"><h3>Угоди</h3>${d.trades.length ? `<div class="tr-scroll"><table class="tr-tab"><thead><tr><th>Час</th><th>Напрям</th><th>Вхід → вихід</th><th>Обсяг</th><th>P/L</th><th>R</th><th>Вихід</th></tr></thead><tbody>
      ${d.trades.slice(0, 20).map(t => `<tr title="${esc(t.why)}"><td>${new Date(t.opened).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</td><td>${t.dir > 0 ? '<span class="up">лонг</span>' : '<span class="dn">шорт</span>'}</td><td>${money(t.entry)} → ${money(t.exit)}</td><td>${t.qty}</td><td class="${t.pnl >= 0 ? "up" : "dn"}">${pm(t.pnl)}</td><td>${pm(t.r)}</td><td>${esc(t.exitWhy)}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="empty">Угод ще немає. Трейдер входить лише тоді, коли збігаються ухил старших ТФ, реакція від рівня і підтвердження потоком ордерів.</p>`}
    ${line ? `<h3 class="tr-sub">Крива балансу</h3><svg class="sp-spark" viewBox="0 0 600 110" preserveAspectRatio="none" aria-hidden="true"><path d="${line}" fill="none" stroke="#ffd88a" stroke-width="2.5" vector-effect="non-scaling-stroke"/></svg>` : ""}</section>`;
  const logB = `<section class="sp-box"><h3>Журнал рішень</h3><ul class="tr-log">${d.log.slice(0, 12).map(l => `<li><span>${new Date(l.t).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" })}</span>${esc(l.text)}</li>`).join("") || '<li class="empty">Порожньо</li>'}</ul></section>`;
  const cfg = trader.cfg ? `<section class="sp-box"><h3>Налаштування стратегії</h3><div class="sp-form sp-grid">${TR_CFG.map(([k, t]) => `<label class="tr-f">${t}<input id="tr_${k}" inputmode="decimal" value="${d.cfg[k]}"></label>`).join("")}</div>
      <div class="sp-actions"><button class="btn-gold" data-act="tr-save">Зберегти</button><button class="btn-ghost" data-act="tr-cfg">Сховати</button></div>
      <p class="sp-note">Зміни діють з наступної хвилини. Стартовий баланс застосовується після «Скинути рахунок».</p></section>` : "";
  return `<section class="sp-box tr"><h3>Агент «Трейдер XAU» · паперова торгівля</h3>${head}
      <div class="sp-actions"><button class="${on ? "btn-ghost" : "btn-gold"}" data-act="${on ? "tr-stop" : "tr-start"}">${on ? "⏸ Пауза" : "▶ Старт"}</button><button class="btn-ghost" data-act="tr-cfg">⚙ Налаштування</button><button class="btn-ghost" data-act="tr-reset">↺ Скинути рахунок</button><button class="btn-ghost" data-act="tr-reload">⟳ Оновити</button></div></section>
    ${cfg}${tiles}${pos}${an}${trades}${logB}
    ${askBtn("Розбір роботи трейдера від Властеліна", "Виклич trader_report і коротко розбери роботу Трейдера XAU: що зараз показує аналіз 4H→5M, чому були або не були входи, як іде статистика, що варто змінити в налаштуваннях.", "Реальних грошей трейдер не використовує.")}`;
}
VIEWS.market = { ico: "◭", title: "РИНОК · XAU/USDT", render() {
  loadMarket();
  const m = market.p, up = m && m.chg >= 0, line = market.kl && market.kl.length > 1 ? sparkPath(market.kl, 600, 140) : "";
  const price = m ? `<div class="mk-price"><small>XAU/USDT · золото (унція) в USDT</small><b>${money(m.last)}</b>
      <span class="${up ? "up" : "dn"}">${up ? "▲ +" : "▼ "}${m.chg.toFixed(2)}% за 24 год</span></div>`
    : `<p class="empty">${esc(market.err || "Завантаження ціни…")}</p>`;
  return `${price}
    ${traderBlock()}
    <h3 class="tr-sec">Ціна і сповіщення</h3>
    ${m ? `<div class="sp-tiles">${tile("Максимум 24 год", money(m.hi))}${tile("Мінімум 24 год", money(m.lo))}${tile("Обсяг 24 год", money(m.vol / 1e6) + " млн")}${tile("Оновлено", market.time.toLocaleTimeString("uk-UA"))}</div>` : ""}
    ${line ? `<section class="sp-box"><h3>Останні 48 годин</h3><svg class="sp-spark" viewBox="0 0 600 140" preserveAspectRatio="none" aria-hidden="true"><path d="${line} L600 140 L0 140 Z" fill="url(#sparkFill)"/><path d="${line}" fill="none" stroke="#ffd88a" stroke-width="2.5" vector-effect="non-scaling-stroke"/></svg>
      <p class="sp-note">Мін. ${money(Math.min(...market.kl))} · макс. ${money(Math.max(...market.kl))} · джерело: ${esc(market.src)}. Ціна оновлюється кожні 20 с, поки розділ відкритий.</p></section>` : ""}
    <div class="sp-actions"><a class="btn-ghost" href="https://www.binance.com/uk-UA/futures/XAUUSDT" target="_blank" rel="noopener">Binance ↗</a><a class="btn-ghost" href="https://www.tradingview.com/symbols/XAUUSD/" target="_blank" rel="noopener">TradingView ↗</a></div>
    ${colForm("market", "Сповіщення про ціну")}
    <section class="sp-box"><h3>Мої сповіщення</h3>${colItems("market", colList("market"), "Сповіщень немає. Задайте рівень — офіс повідомить, коли ціна його перетне (поки сайт відкритий).")}</section>
    ${askBtn("Огляд золота від Властеліна", `Ціна XAU/USDT зараз ${m ? money(m.last) : "невідома"} (${m ? m.chg.toFixed(2) + "% за 24 год" : ""}). Коротко: які фактори зазвичай впливають на золото і на що мені звернути увагу. Без інвестиційних порад.`, "Це не інвестиційна порада.")}`;
} };

/* --- Розробка гри --- */
const GAME_FIELDS = [["name", "Назва гри"], ["genre", "Жанр"], ["platform", "Платформи (ПК, мобільні…)"], ["engine", "Рушій (Unity, Godot…)"], ["idea", "Концепт в одному реченні"]];
VIEWS.game = { ico: "◈", title: "РОЗРОБКА ГРИ", render() {
  const v = colList("game"), n = countBy(v, "st"), c = wsOf("game").concept || {};
  const bugs = v.filter(x => x.kind === "bug" && x.st !== "done").length, prog = share(n.done || 0, v.length);
  const kinds = COL.game.fields[1].opts.map(([k, t]) => { const all = v.filter(x => x.kind === k); return [t, share(all.filter(x => x.st === "done").length, all.length), `${all.filter(x => x.st === "done").length}/${all.length}`]; }).filter(r => r[2] !== "0/0");
  return `<div class="sp-tiles">${tile("Прогрес гри", prog + "%", `${n.done || 0} з ${v.length} задач`)}${tile("В роботі", n.work || 0)}${tile("Відкриті баги", bugs ? `<span class="dn">${bugs}</span>` : 0)}${tile("Заплановано", n.todo || 0)}</div>
    <section class="sp-box"><h3>Концепт гри</h3><div class="sp-form sp-grid">${GAME_FIELDS.map(([k, t]) => `<input id="gc_${k}" placeholder="${t}" aria-label="${t}" title="${t}" maxlength="${k === "idea" ? 200 : 60}" value="${esc(c[k] || "")}" data-enter="game-save"${k === "idea" ? ' class="wide"' : ""}>`).join("")}
      <button class="btn-gold" data-act="game-save">Зберегти концепт</button></div></section>
    ${colForm("game", "Беклог: нова задача")}
    <div class="sp-cols">
      <section class="sp-box"><h3>Беклог</h3>${colItems("game", v, "Беклог порожній. Додайте фічі, баги, графіку — прогрес гри рахується з виконаних задач.")}</section>
      <section class="sp-box"><h3>Прогрес за напрямами</h3>${kinds.length ? bars(kinds) : `<p class="empty">Немає даних</p>`}</section>
    </div>
    ${askBtn("Ідеї механік від Властеліна", `Моя гра: ${[c.name, c.genre, c.platform, c.engine, c.idea].filter(Boolean).join(", ") || "концепт ще не заповнено"}. Запропонуй 5 ігрових механік і план першої демо-версії (MVP) на 4 тижні.`)}${SYNC_NOTE}`;
} };

/* --- Бізнес --- */
VIEWS.biz = { ico: "▥", title: "БІЗНЕС", render() {
  const v = colList("biz"), cur = finCur(), rev = v.reduce((a, x) => a + toNum(x.rev), 0), goal = v.reduce((a, x) => a + toNum(x.goal), 0);
  const working = v.filter(x => x.st === "work" || x.st === "scale").length;
  return `<div class="sp-tiles">${tile("Напрямів", v.length)}${tile("Працюють", working)}${tile("Дохід / міс", money(rev, cur))}${tile("Виконання цілі", share(rev, goal) + "%", `ціль ${money(goal, cur)}`)}</div>
    ${colForm("biz", "Новий бізнес або напрям")}
    <div class="sp-cols">
      <section class="sp-box"><h3>Бізнеси</h3>${colItems("biz", v, "Додайте перший бізнес. Статус: Ідея → Запуск → Працює → Масштабування → Пауза.")}</section>
      <section class="sp-box"><h3>Дохід до цілі</h3>${v.some(x => toNum(x.goal)) ? bars(v.filter(x => toNum(x.goal)).map(x => [x.title, Math.min(100, share(toNum(x.rev), toNum(x.goal))), share(toNum(x.rev), toNum(x.goal)) + "%"]), "gold") : `<p class="empty">Задайте цілі доходу.</p>`}</section>
    </div>
    ${askBtn("Стратегія від Властеліна", "Проаналізуй мої бізнес-напрями (статус, дохід, ціль) і запропонуй, на чому зосередитися цього місяця, щоб найшвидше вийти на ціль.")}${SYNC_NOTE}`;
} };

/* --- Інвестиції --- */
function invStats() {
  const v = colList("invest"); let inv = 0, val = 0; const kinds = {};
  for (const x of v) { const a = toNum(x.inv), b = x.val === "" || x.val == null ? a : toNum(x.val); inv += a; val += b; kinds[x.kind] = (kinds[x.kind] || 0) + b; }
  return { v, inv, val, pl: val - inv, kinds };
}
VIEWS.invest = { ico: "◔", title: "ІНВЕСТИЦІЇ", render() {
  const s = invStats(), cur = finCur(), up = s.pl >= 0;
  const alloc = INV_KINDS.filter(([k]) => s.kinds[k]).map(([k, t]) => [t, share(s.kinds[k], s.val), share(s.kinds[k], s.val) + "%"]);
  return `<div class="sp-tiles">${tile("Вкладено", money(s.inv, cur))}${tile("Поточна вартість", money(s.val, cur))}${tile("Прибуток / збиток", `<span class="${up ? "up" : "dn"}">${up ? "+" : "−"}${money(Math.abs(s.pl))}</span>`)}${tile("Дохідність", `<span class="${up ? "up" : "dn"}">${s.inv ? (up ? "+" : "") + (s.pl / s.inv * 100).toFixed(1) : "0"}%</span>`)}</div>
    ${market.p ? note(`Довідка: золото (XAU/USDT) зараз ${money(market.p.last)} за унцію — розділ «Ринок».`) : ""}
    ${colForm("invest", "Новий актив")}
    <div class="sp-cols">
      <section class="sp-box"><h3>Портфель</h3>${colItems("invest", s.v, "Портфель порожній. Додайте актив і суму вкладення; поточну вартість оновлюйте кнопкою «Змінити».")}</section>
      <section class="sp-box"><h3>Розподіл за типами</h3>${alloc.length ? bars(alloc, "gold") : `<p class="empty">Немає активів.</p>`}</section>
    </div>
    ${askBtn("Огляд портфеля від Властеліна", "Оціни диверсифікацію мого інвестиційного портфеля і ризики концентрації. Коротко, без конкретних порад купити чи продати.", "Це не інвестиційна порада.")}${SYNC_NOTE}`;
} };

/* --- Юридичний блок --- */
VIEWS.legal = { ico: "§", title: "ЮРИДИЧНИЙ БЛОК", render() {
  const v = colList("legal"), live = v.filter(x => x.st !== "closed" && x.date);
  const soonN = live.filter(x => { const d = daysTo(x.date); return d >= 0 && d <= 30; }).length, expired = live.filter(x => daysTo(x.date) < 0).length;
  const list = v.slice().sort((a, b) => (a.st === "closed") - (b.st === "closed") || (a.date || "9999").localeCompare(b.date || "9999"));
  return `<div class="sp-tiles">${tile("Документів", v.length)}${tile("Діють", v.filter(x => x.st === "active").length)}${tile("Закінчуються ≤30 дн.", soonN ? `<span class="warn">${soonN}</span>` : 0)}${tile("Термін минув", expired ? `<span class="dn">${expired}</span>` : 0)}</div>
    ${colForm("legal", "Новий документ")}
    <section class="sp-box"><h3>Документи · спершу найтерміновіші</h3>${colItems("legal", list, "Документів поки немає. Додайте договори, ліцензії, установчі документи з датою закінчення — офіс підсвітить термінові.")}</section>
    ${askBtn("Юридичний чек-лист від Властеліна", "За списком моїх документів підкажи, що варто перевірити або продовжити найближчим часом, і які типові документи ще можуть знадобитися для мого бізнесу.", "Не замінює консультацію юриста.")}
    ${note("Тут зберігаються назви й терміни документів. Самі файли та персональні дані сюди не завантажуйте.")}${SYNC_NOTE}`;
} };

/* --- Загальний прогрес (останній пункт меню) --- */
function progressData() {
  const rows = [];
  const add = (name, done, total, extra) => rows.push({ name, done, total, p: share(done, total), extra });
  const s = stats(); if (projects.length) rows.push({ name: "Проєкти", p: s.avg, extra: `${s.n} проєктів, середній прогрес`, done: s.done, total: s.n });
  const v = k => colList(k);
  if (v("media").length) add("Медіацентр", v("media").filter(x => x.st === "pub").length, v("media").length, "опубліковано відео");
  if (v("logistics").length) add("Логістика", v("logistics").filter(x => x.st === "done").length, v("logistics").length, "доставлено");
  if (v("game").length) add("Розробка гри", v("game").filter(x => x.st === "done").length, v("game").length, "задач беклогу");
  const b = v("biz"), rev = b.reduce((a, x) => a + toNum(x.rev), 0), goal = b.reduce((a, x) => a + toNum(x.goal), 0);
  if (goal) rows.push({ name: "Бізнес", p: Math.min(100, share(rev, goal)), extra: "дохід до цілі місяця" });
  const ld = v("legal").filter(x => x.st !== "closed"); if (ld.length) add("Юридичний блок", ld.filter(x => x.st === "active" && (daysTo(x.date) === null || daysTo(x.date) >= 0)).length, ld.length, "документів у порядку");
  let td = 0, tt = 0; const perSec = [];
  for (const [slug, name] of Object.entries(SECTION_NAMES)) {
    const t = (ws[slug] && Array.isArray(ws[slug].tasks)) ? ws[slug].tasks : [];
    if (t.length) { const d = t.filter(x => x.status === "done").length; td += d; tt += t.length; perSec.push([name, share(d, t.length), `${d}/${t.length}`]); }
  }
  if (tt) add("Технічні завдання", td, tt, "виконано в усіх розділах");
  const overall = rows.length ? Math.round(rows.reduce((a, r) => a + r.p, 0) / rows.length) : 0;
  return { rows, overall, perSec, td, tt };
}
VIEWS.progress = { ico: "◎", title: "ЗАГАЛЬНИЙ ПРОГРЕС", render() {
  const d = progressData(), f = finStats(), inv = invStats(), cur = finCur();
  const ring = `<svg class="pg-ring" viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="50" fill="none" stroke="rgba(63,184,255,.15)" stroke-width="10"/>
    <circle cx="60" cy="60" r="50" fill="none" stroke="url(#goldGrad)" stroke-width="10" stroke-linecap="round" stroke-dasharray="${(d.overall / 100 * 314.16).toFixed(1)} 400" transform="rotate(-90 60 60)"/>
    <text x="60" y="68" text-anchor="middle">${d.overall}%</text></svg>`;
  return `<div class="pg-head">${ring}<div><h3>Загальний прогрес офісу</h3><p class="sp-note">Середнє за всіма блоками, де вже є дані. Додавайте дані в розділи — картина ставатиме точнішою.</p></div></div>
    <div class="sp-tiles">${tile("Баланс", money(f.bal, cur))}${tile("Інвестиції", money(inv.val, cur), `${inv.pl >= 0 ? "+" : "−"}${money(Math.abs(inv.pl))}`)}${tile("ТЗ виконано", `${d.td}/${d.tt}`)}${tile("XAU/USDT", market.p ? money(market.p.last) : "—")}</div>
    <div class="sp-cols">
      <section class="sp-box"><h3>Прогрес за блоками</h3>${d.rows.length ? `<ul class="sp-bars">${d.rows.map(r => `<li><span>${esc(r.name)} <small class="muted">· ${esc(r.extra || "")}</small></span><i><b style="width:${r.p}%"></b></i><code>${r.p}%</code></li>`).join("")}</ul>` : `<p class="empty">Поки немає даних. Почніть з будь-якого розділу.</p>`}</section>
      <section class="sp-box"><h3>Технічні завдання за розділами</h3>${d.perSec.length ? bars(d.perSec, "gold") : `<p class="empty">Технічних завдань ще немає.</p>`}</section>
    </div>
    ${askBtn("Пріоритети тижня від Властеліна", "Подивись на загальний прогрес офісу за всіма блоками і назви 3 головні пріоритети на цей тиждень із коротким поясненням.", "Розумна модель, ≈$0.01–0.03.")}`;
} };

// Коротке зведення для Властеліна (щоб аналізував усі блоки без зайвих токенів).
function officeSummary() {
  try {
    const f = finStats(), inv = invStats(), cur = finCur(), n = k => countBy(colList(k), "st");
    const legalSoon = colList("legal").filter(x => x.st !== "closed" && x.date && daysTo(x.date) <= 30).map(x => `${x.title} (${fmtDate(x.date)})`);
    const b = colList("biz");
    return [
      `Фінанси: баланс ${money(f.bal, cur)}, за місяць +${money(f.inM)} / −${money(f.outM)}, операцій ${f.ops.length}; топ витрат: ${Object.entries(f.cats).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${money(v)}`).join(", ") || "немає"}.`,
      `YouTube: ${colList("media").length} відео (${Object.entries(n("media")).map(([k, v]) => `${(COL.media.st.find(s => s[0] === k) || [, k])[1]} ${v}`).join(", ") || "немає"}).`,
      `Логістика: ${Object.entries(n("logistics")).map(([k, v]) => `${(COL.logistics.st.find(s => s[0] === k) || [, k])[1]} ${v}`).join(", ") || "немає відправлень"}.`,
      market.p ? `Ринок: XAU/USDT ${money(market.p.last)} (${market.p.chg.toFixed(2)}% за 24 год).` : "",
      `Гра: ${[wsOf("game").concept?.name, wsOf("game").concept?.genre].filter(Boolean).join(", ") || "концепт не заповнено"}; беклог ${colList("game").length}, виконано ${n("game").done || 0}.`,
      `Бізнес: ${b.map(x => `${x.title} (${(COL.biz.st.find(s => s[0] === x.st) || [, ""])[1]}, ${money(toNum(x.rev))}/${money(toNum(x.goal))})`).join("; ") || "немає"}.`,
      `Інвестиції: вкладено ${money(inv.inv, cur)}, зараз ${money(inv.val, cur)}.`,
      `Юридичне: документів ${colList("legal").length}; термінові: ${legalSoon.join(", ") || "немає"}.`,
      `Загальний прогрес офісу: ${progressData().overall}%.`
    ].filter(Boolean).join("\n").slice(0, 1800);
  } catch (e) { return ""; }
}
function refreshPanel(...which) {
  if (section === "home" || !which.includes(section)) return;
  const f = document.activeElement;   // не перемальовувати, поки людина щось вводить у панелі
  if (f && $("spBody").contains(f) && /INPUT|TEXTAREA|SELECT/.test(f.tagName)) return;
  renderPanel();
}
function openPanel(slug) {
  const v = VIEWS[slug], first = section === "home";
  if (section !== slug) spTab = "main";
  section = slug; setActive(slug);
  const num = String(Object.values(SLUGS).indexOf(slug) + 1).padStart(2, "0");
  $("spTitle").innerHTML = `<b class="ico">${esc(v.ico)}</b> ${v.title}`;
  $("spCode").textContent = `SYS.${num} // ${slug.toUpperCase()}`;
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

async function trAct(body, msg) {
  try { await brainApi("/trader", "POST", body); if (msg) toast(msg); } catch (e) { toast(e.message || "Помилка сервера"); }
  loadTrader(true);
}
const PANEL_ACTS = {
  "tr-start"() { trAct({ action: "start" }, "Трейдера запущено"); },
  "tr-stop"() { trAct({ action: "stop" }, "Трейдер на паузі"); },
  "tr-reload"() { loadTrader(true); },
  "tr-cfg"() { trader.cfg = !trader.cfg; renderPanel(); },
  "tr-close"() { if (confirm("Закрити паперову позицію за поточною ціною?")) trAct({ action: "close" }, "Позицію закрито"); },
  "tr-reset"() { if (confirm("Скинути паперовий рахунок? Усі угоди й статистику буде видалено, налаштування залишаться.")) trAct({ action: "reset" }, "Рахунок скинуто"); },
  "tr-save"() {
    const cfg = {}; for (const [k] of TR_CFG) { const v = $("tr_" + k).value.replace(",", ".").trim(); if (v) cfg[k] = +v; }
    trader.cfg = false; trAct({ action: "config", cfg }, "Налаштування збережено");
  },
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
  voice() { go("home"); startVoice(); },
  tab(i, b) { spTab = b.dataset.k; renderPanel(); $("spBody").scrollTop = 0; },
  "t-add"() {
    const title = $("spTTitle").value.trim(); if (!title) { $("spTTitle").focus(); return; }
    wsOf(section).tasks.unshift({ title: title.slice(0, 100), desc: $("spTDesc").value.trim().slice(0, 2000), status: "new", at: Date.now() });
    saveWs(); renderPanel(); toast("Завдання додано");
  },
  "t-st"(i) { const t = wsOf(section).tasks[i]; if (!t) return; t.status = TASK_NEXT[t.status] || "work"; saveWs(); renderPanel(); },
  "t-del"(i) {
    const list = wsOf(section).tasks, t = list[i]; if (!t || !confirm(`Видалити завдання «${t.title}»?`)) return;
    list.splice(i, 1); saveWs(); renderPanel(); toast("Завдання видалено");
  },
  "w-add"() {
    const title = $("spWTitle").value.trim(); if (!title) { $("spWTitle").focus(); return; }
    wsOf(section).wins.push({ title: title.slice(0, 60), text: $("spWText").value.trim().slice(0, 2000), at: Date.now() });
    saveWs(); renderPanel(); toast("Вікно додано");
  },
  "w-del"(i) {
    const list = wsOf(section).wins, x = list[i]; if (!x || !confirm(`Видалити вікно «${x.title}»?`)) return;
    list.splice(i, 1); saveWs(); renderPanel(); toast("Вікно видалено");
  },
  // Розділи з власними даними (COL): додати / статус / змінити суми / видалити
  "c-add"() {
    const c = COL[section]; if (!c) return;
    const x = { id: uid(), at: Date.now() };
    for (const f of c.fields) {
      const el = $("cf_" + f.k); let v = el.value.trim();
      if (f.req && !v) { el.focus(); toast(`Заповніть: ${f.label}`); return; }
      if (f.type === "number" && v) {
        if (!Number.isFinite(parseFloat(v.replace(/[\s ]/g, "").replace(",", ".")))) { el.focus(); toast(`«${f.label}» — має бути число`); return; }
        v = toNum(v);
      }
      if (f.type === "url" && v && !/^https?:\/\//i.test(v)) v = "https://" + v;
      x[f.k] = typeof v === "string" ? v.slice(0, 300) : v;
    }
    if (c.st) x.st = c.st[0][0];
    colList(section).unshift(x); saveWs(); renderPanel(); toast("Додано");
    if (section === "market") checkAlerts();
  },
  "c-st"(_, b) {
    const c = COL[section], x = c && colList(section).find(i => i.id === b.dataset.id); if (!x || !c.st) return;
    const i = c.st.findIndex(o => o[0] === x.st); x.st = c.st[(i + 1) % c.st.length][0]; x.at = Date.now();
    saveWs(); renderPanel();
  },
  "c-edit"(_, b) {
    const c = COL[section], x = c && colList(section).find(i => i.id === b.dataset.id); if (!x || !c.edit) return;
    for (const k of c.edit) {
      const f = c.fields.find(f => f.k === k), v = prompt(`${f.label} — «${x.title || ""}»:`, x[k] ?? "");
      if (v === null) return;
      if (v.trim() !== "") { if (!Number.isFinite(parseFloat(v.replace(/[\s ]/g, "").replace(",", ".")))) { toast("Потрібне число"); return; } x[k] = toNum(v); }
    }
    x.at = Date.now(); saveWs(); renderPanel(); toast("Збережено");
  },
  "c-del"(_, b) {
    const list = COL[section] ? colList(section) : [], i = list.findIndex(x => x.id === b.dataset.id); if (i < 0) return;
    const name = list[i].title || money(toNum(list[i].amount || list[i].price));
    if (!confirm(`Видалити «${name}»?`)) return;
    list.splice(i, 1); saveWs(); renderPanel(); toast("Видалено");
  },
  "fin-cur"(_, b) { wsOf("finance").cur = b.dataset.k; saveWs(); renderPanel(); },
  "game-save"() {
    const c = {}; for (const [k] of GAME_FIELDS) c[k] = $("gc_" + k).value.trim().slice(0, k === "idea" ? 200 : 60);
    wsOf("game").concept = c; saveWs(); renderPanel(); toast("Концепт збережено");
  },
  ask(_, b) {   // готовий запит до Властеліна з розділу
    if (!agentReady()) { toast("Спершу підключіть AI-агента в «Налаштуваннях»"); return; }
    if (pending) return;
    openChat(b.dataset.q); sendChat();
  },
  // «Властелін»: аналіз, рішення щодо пропозицій і керування пам'яттю
  "brain-ask"() {
    if (!agentReady()) { toast("Спершу підключіть AI-агента в «Налаштуваннях»"); return; }
    if (pending) return;
    openChat("Проаналізуй стан офісу: проєкти, технічні завдання, пам'ять і GitHub. Коротко дай висновки і запропонуй до 3 конкретних покращень через пропозиції.");
    sendChat();
  },
  "pr-ok"(id) {
    brainDo(async () => {
      const { proposal: p } = await brainApi("/proposals", "POST", { id, decision: "approved" });
      const s = SECTION_NAMES[p.section] ? p.section : "business";
      wsOf(s).tasks.unshift({ title: p.title.slice(0, 100), desc: `${p.details}\n\nОцінка вартості: ${p.cost}. Пропозиція Властеліна №${p.id}.`.slice(0, 2000), status: "new", at: Date.now() });
      saveWs();
      toast(`Схвалено → технічне завдання в розділі «${SECTION_NAMES[s]}»`);
    });
  },
  "pr-no"(id) {
    const p = (brain.proposals || []).find(x => x.id === id);
    if (p && !confirm(`Відхилити пропозицію «${p.title}»?`)) return;
    brainDo(() => brainApi("/proposals", "POST", { id, decision: "rejected" }), "Пропозицію відхилено");
  },
  "m-add"() {
    const text = $("spMText").value.trim(); if (!text) { $("spMText").focus(); return; }
    brainDo(() => brainApi("/memory", "POST", { text, category: $("spMCat").value }), "Запам'ятав");
  },
  "m-edit"(id) {
    const m = (brain.memory || []).find(x => x.id === id); if (!m) return;
    const text = prompt("Змінити запис пам'яті:", m.text);
    if (text === null || !text.trim() || text.trim() === m.text) return;
    brainDo(() => brainApi("/memory", "PUT", { id, text: text.trim() }), "Запис змінено");
  },
  "m-del"(id) {
    const m = (brain.memory || []).find(x => x.id === id);
    if (!m || !confirm(`Видалити з пам'яті: «${m.text}»?`)) return;
    brainDo(() => brainApi("/memory?id=" + id, "DELETE"), "Запис видалено");
  }
};
$("spBody").addEventListener("click", e => {
  const b = e.target.closest("[data-act]"); if (!b || b.type === "range") return;
  const f = PANEL_ACTS[b.dataset.act]; if (f) f(+b.dataset.i, b);
});
$("spBody").addEventListener("keydown", e => { const a = e.target.dataset.enter; if (e.key === "Enter" && a) PANEL_ACTS[a](); });
$("spBody").addEventListener("input", e => {   // повзунок: оновлюємо віджет і підпис без перебудови панелі
  const el = e.target; if (el.dataset.act !== "p-prog") return;
  const p = projects[+el.dataset.i]; if (!p) return;
  p.progress = +el.value; $("spPv" + el.dataset.i).textContent = p.progress + "%"; renderProjects(true);
});
route();

/* ====== синхронізація між пристроями (крок 1 «Апгрейду») ======
   Кожна колекція — окремий JSON на сервері (D1) з часом зміни; перемагає новіша зміна.
   Перед першим прийомом даних із сервера локальна копія зберігається як vl_backup_<ключ>. */
const SYNC_DEFAULTS = { vl_ws: {}, vl_history: [] };
for (const [k, d] of Object.entries(SYNC_DEFAULTS)) { try { if (localStorage.getItem(k) === null) localStorage.setItem(k, JSON.stringify(d)); } catch (e) {} }
const LS_OF = Object.fromEntries(Object.entries(SYNC_KEYS).map(([ls, key]) => [key, ls]));
function applyRemote(key, value) {
  applyingRemote = true;
  try {
    if (key === "projects" && Array.isArray(value)) { projects = value; renderProjects(); }
    else if (key === "events" && Array.isArray(value)) { events = value; renderEvents(); }
    else if (key === "ws" && value && typeof value === "object") { ws = value; saveWs(); if (section !== "home") renderPanel(); }
    else if (key === "history" && Array.isArray(value)) { history = value; saveHistory(); renderChat(); }
  } finally { applyingRemote = false; }
}
sync = {
  meta: store.get("vl_sync", {}),   // { key: час останньої відомої зміни }
  dirty: new Set(), timer: 0, busy: false, state: "off", msg: "Не налаштовано", at: 0,
  saveMeta() { try { localStorage.setItem("vl_sync", JSON.stringify(this.meta)); } catch (e) {} },
  setState(st, msg) { this.state = st; this.msg = msg; refreshPanel("business", "dev"); },
  touch(key) {
    this.meta[key] = Date.now(); this.saveMeta(); this.dirty.add(key);
    clearTimeout(this.timer); this.timer = setTimeout(() => this.run(), 800);
  },
  async api(method, body) {
    const r = await fetch(agent.url.replace(/\/+$/, "") + "/state", {
      method, headers: { "Content-Type": "application/json", "X-Access-Code": agent.code || "" },
      body: body ? JSON.stringify(body) : undefined
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Помилка ${r.status}`);
    return j;
  },
  async pull() {
    const { state = {} } = await this.api("GET");
    for (const key of Object.values(SYNC_KEYS)) {
      const s = state[key], mine = this.meta[key] || 0;
      if (s && s.t > mine) {
        if (key === "history" && pending) continue;   // не підміняємо розмову посеред відповіді
        let value; try { value = JSON.parse(s.v); } catch (e) { continue; }
        if (!mine) { try { const cur = localStorage.getItem(LS_OF[key]); if (cur && cur !== s.v) localStorage.setItem("vl_backup_" + key, cur); } catch (e) {} }
        applyRemote(key, value); this.meta[key] = s.t;
      } else if (!s || s.t < mine) {
        if (!mine) this.meta[key] = Date.now();   // перше вивантаження даних цього пристрою
        this.dirty.add(key);
      }
    }
    this.saveMeta();
  },
  async push() {
    for (const key of [...this.dirty]) {
      const v = localStorage.getItem(LS_OF[key]); if (v === null) { this.dirty.delete(key); continue; }
      const j = await this.api("PUT", { key, v, t: this.meta[key] || Date.now() });
      this.dirty.delete(key);
      if (j.applied === false && j.v) { try { applyRemote(key, JSON.parse(j.v)); } catch (e) {} this.meta[key] = j.t; }
    }
    this.saveMeta();
  },
  async run(full = false) {
    if (!agentReady()) { this.setState("off", "Не налаштовано (потрібен AI-агент)"); return; }
    if (this.busy) { clearTimeout(this.timer); this.timer = setTimeout(() => this.run(full), 1500); return; }
    this.busy = true;
    try {
      if (full) await this.pull();
      await this.push();
      this.at = Date.now(); this.setState("ok", "Синхронізовано " + new Date().toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" }));
    } catch (e) {
      this.setState("bad", e.message || "Немає зв'язку");
      clearTimeout(this.timer); this.timer = setTimeout(() => this.run(full), 30000);   // повтор пізніше; зміни не губляться
    } finally { this.busy = false; }
  }
};
sync.run(true);
loadBrain();   // лічильник нових пропозицій на кнопці «Властелін»
renderHomeFin();
setInterval(() => { if (section === "market" && document.visibilityState === "visible") { loadMarket(true); loadTrader(true); } }, 20000);
setInterval(() => { if (document.visibilityState === "visible") { sync.run(true); loadBrain(); } }, 60000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") sync.run(true); });
addEventListener("online", () => sync.run(true));
