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
    const ctx = { user: CONFIG.userName, city: CONFIG.city, now: new Date().toLocaleString("uk-UA"), projects, events, tasks };
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
const SLUGS = { "Головна": "home", "Бізнес-центр": "business", "Проєкти": "projects", "Фінанси": "finance", "Розробка": "dev",
  "Медіацентр": "media", "Комунікації": "comms", "Аналітика": "analytics", "Властелін": "brain", "Налаштування": "settings" };
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
/* ====== робочий простір розділу: технічні завдання (ТЗ) і власні вікна ======
   vl_ws = { [section]: { tasks: [{title, desc, status, at}], wins: [{title, text, at}] } } */
let ws = store.get("vl_ws", {});
if (!ws || typeof ws !== "object" || Array.isArray(ws)) ws = {};
const wsOf = s => (ws[s] = ws[s] && Array.isArray(ws[s].tasks) && Array.isArray(ws[s].wins) ? ws[s] : { tasks: [], wins: [] });
const saveWs = () => store.set("vl_ws", ws);
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
    ${note("Статус змінюється натисканням: Нове → В роботі → Готово. Завдання зберігаються в цьому браузері; пізніше (план «Апгрейд») їх зможуть брати в роботу агенти.")}`;
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
const SECTION_NAMES = { business: "Бізнес-центр", projects: "Проєкти", finance: "Фінанси", dev: "Розробка", media: "Медіацентр", comms: "Комунікації", analytics: "Аналітика" };
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
  code.textContent = n ? `${n} нов.` : "09"; code.classList.toggle("hot", n > 0);
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
function refreshPanel(...which) { if (section !== "home" && which.includes(section)) renderPanel(); }
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
setInterval(() => { if (document.visibilityState === "visible") { sync.run(true); loadBrain(); } }, 60000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") sync.run(true); });
addEventListener("online", () => sync.run(true));
