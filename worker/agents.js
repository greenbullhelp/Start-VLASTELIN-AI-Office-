// Команда агентів: керівник звертається до Властеліна, той роздає задачі агентам відділів (assign_task).
// Агенти працюють у хмарі за розкладом (по одному кроку на хвилину), Контролер перевіряє кожен результат,
// а остаточне рішення («Схвалити» / «На доопрацювання») — лише за керівником.
// Програміст: після схвалення специфікації створює GitHub issue з міткою `agent` у репозиторії гри
// (якщо підключено GH_TOKEN + GAME_REPO) → GitHub Action з Claude Code робить PR → керівник робить Merge.

export const DEPTS = { game: 'Відділ розробки гри' };
export const ROLES = {
  scenarist: { dept: 'game', name: 'Сценарист', icon: '✎', job: 'світ, сюжет, персонажі, квести, діалоги, тон і стиль оповіді',
    prompt: 'Ти — Сценарист ігрової студії. Пишеш світ, сюжет, персонажів, квести й діалоги. Думай про мотивацію гравця і зв\'язок історії з ігровими механіками. Пиши конкретно: імена, місця, сцени, репліки. Оригінальні ідеї — жодних чужих захищених персонажів, світів і брендів.' },
  economist: { dept: 'game', name: 'Економіст', icon: '⚖', job: 'ігрова економіка: валюти, ціни, нагороди, прогресія, баланс, монетизація',
    prompt: 'Ти — Економіст ігрової студії (game economy designer). Проєктуєш валюти, джерела й стоки ресурсів, ціни, нагороди, криві прогресії та монетизацію без «pay-to-win». Давай таблиці з конкретними числами й формулами, пояснюй, як перевірити баланс.' },
  designer: { dept: 'game', name: 'Дизайнер', icon: '◧', job: 'геймдизайн і UI/UX: механіки, рівні, екрани, візуальний стиль, ТЗ для художника',
    prompt: 'Ти — Дизайнер ігрової студії (геймдизайн + UI/UX + арт-дирекшн). Описуєш механіки, рівні, екрани інтерфейсу (схема екрана текстом), візуальний стиль, палітру й ТЗ для художника. Картинок ти не малюєш — даєш точні описи й простий текстовий макет.' },
  programmer: { dept: 'game', name: 'Програміст', icon: '⌘', job: 'архітектура, технічні специфікації, код; через GitHub — PR у репозиторій гри',
    prompt: 'Ти — Програміст ігрової студії. Пишеш технічну специфікацію: архітектуру, модулі, структури даних, кроки реалізації й критерії приймання. Додавай ключові фрагменти коду. Специфікація має бути такою, щоб інший розробник (Claude Code у GitHub) реалізував її без уточнень.' },
  controller: { dept: '*', name: 'Контролер', icon: '◉', job: 'перевіряє якість кожного результату, повертає на доопрацювання, стежить за витратами',
    prompt: 'Ти — Контролер студії. Перевіряєш результат агента на відповідність завданню і концепту гри: повнота, конкретика, узгодженість з іншими документами, відсутність чужих захищених персонажів/брендів, реалістичність.' }
};
const WORKERS = Object.keys(ROLES).filter(k => k !== 'controller');
const MAX_REWORK = 2;            // скільки разів Контролер може повернути задачу сам
const LOCK_MS = 10 * 6e4;        // задача «зависла» в роботі довше — повертаємо в чергу
const PRICES = { 'claude-haiku-5-5': [0.10, 0.50], 'claude-sonnet-5-5': [2, 10], 'claude-opus-5-5': [4, 20] };
const cost = (m, u = {}) => { const p = PRICES[m] || PRICES['claude-opus-5-5']; return ((u.input_tokens || 0) * p[0] + (u.output_tokens || 0) * p[1]) / 1e6; };
const today = () => new Date().toISOString().slice(0, 10);

const ready = new WeakSet();
export async function ensureAgentSchema(db) {
  if (ready.has(db)) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS agent_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, dept TEXT NOT NULL, role TEXT NOT NULL, title TEXT NOT NULL, brief TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued', result TEXT NOT NULL DEFAULT '', review TEXT NOT NULL DEFAULT '', feedback TEXT NOT NULL DEFAULT '', score INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0, issue TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL, updated INTEGER NOT NULL, locked INTEGER NOT NULL DEFAULT 0)`).run();
  ready.add(db);
}
// Статуси: queued → working → review (Контролер) → ready (чекає керівника) → done | (queued з зауваженнями) | rejected
export const STATUS = { queued: 'У черзі', working: 'В роботі', review: 'Перевіряє Контролер', ready: 'Чекає вашого рішення', done: 'Схвалено', rejected: 'Скасовано' };

export async function assignTask(db, i = {}) {
  await ensureAgentSchema(db);
  const role = String(i.role || ''), title = String(i.title || '').trim().slice(0, 140), brief = String(i.brief || '').trim().slice(0, 3000);
  if (!WORKERS.includes(role)) return { error: `Невідома роль. Доступні: ${WORKERS.map(r => `${r} (${ROLES[r].name})`).join(', ')}` };
  if (!title || !brief) return { error: 'Потрібні назва і опис завдання' };
  const { results } = await db.prepare("SELECT COUNT(*) AS n FROM agent_tasks WHERE status IN ('queued','working','review')").all();
  if ((results[0].n || 0) >= 20) return { error: 'Черга агентів переповнена (20 активних задач) — дочекайтеся виконання' };
  const now = Date.now();
  const r = await db.prepare('INSERT INTO agent_tasks (dept, role, title, brief, created, updated) VALUES (?, ?, ?, ?, ?, ?)').bind(ROLES[role].dept, role, title, brief, now, now).run();
  return { id: r.meta.last_row_id, role, name: ROLES[role].name, title };
}
export async function listTasks(db, limit = 60) {
  await ensureAgentSchema(db);
  const { results } = await db.prepare('SELECT * FROM agent_tasks ORDER BY id DESC LIMIT ?').bind(limit).all();
  return results || [];
}
export async function teamView(db, env = {}) {
  const tasks = await listTasks(db, 80);
  const spentToday = Number(env.BUDGET ? await env.BUDGET.get('agents:' + today()) : 0) || 0;
  const roles = Object.entries(ROLES).map(([k, r]) => {
    const mine = k === 'controller' ? tasks.filter(t => t.status === 'review') : tasks.filter(t => t.role === k);
    const busy = k === 'controller' ? mine.length > 0 : mine.some(t => t.status === 'working');
    return { k, ...r, prompt: undefined, busy, queued: k === 'controller' ? mine.length : mine.filter(t => t.status === 'queued').length,
      done: k === 'controller' ? tasks.filter(t => t.review).length : mine.filter(t => t.status === 'done').length, cost: +mine.reduce((s, t) => s + (t.cost || 0), 0).toFixed(3) };
  });
  return { roles, tasks, budget: { spent: +spentToday.toFixed(3), limit: Number(env.AGENTS_DAILY_USD || 0.3) }, github: Boolean(env.GH_TOKEN && env.GAME_REPO), repo: env.GAME_REPO || '' };
}
export async function teamReport(db, env) {
  const v = await teamView(db, env);
  return [`Відділ гри: ${v.roles.map(r => `${r.name} (${r.busy ? 'працює' : 'вільний'}, у черзі ${r.queued}, схвалено ${r.done})`).join('; ')}.`,
    `Витрати агентів сьогодні $${v.budget.spent} з $${v.budget.limit}. GitHub гри: ${v.github ? v.repo : 'не підключено'}.`,
    'Задачі: ' + (v.tasks.slice(0, 15).map(t => `№${t.id} [${ROLES[t.role]?.name}] ${t.title} — ${STATUS[t.status]}${t.score ? `, оцінка ${t.score}/10` : ''}`).join('; ') || 'немає')].join('\n');
}

// Контекст гри: концепт і беклог з розділу «Розробка гри» + схвалені документи команди («біблія гри»)
async function gameContext(db) {
  let concept = {}, backlog = [];
  try {
    const r = await db.prepare('SELECT v FROM state WHERE k = ?').bind('ws').first();
    const g = r ? (JSON.parse(r.v).game || {}) : {};
    concept = g.concept || {}; backlog = (g.backlog || []).slice(0, 30);
  } catch {}
  const { results } = await db.prepare("SELECT id, role, title, result FROM agent_tasks WHERE status = 'done' ORDER BY id DESC LIMIT 12").all();
  const docs = (results || []).map(d => `### №${d.id} ${ROLES[d.role]?.name}: ${d.title}\n${String(d.result).slice(0, 2500)}`).join('\n\n');
  const c = Object.entries({ 'Назва': concept.name, 'Жанр': concept.genre, 'Платформи': concept.platform, 'Рушій': concept.engine, 'Концепт': concept.idea }).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');
  return `КОНЦЕПТ ГРИ (з розділу «Розробка гри»):\n${c || 'ще не заповнений — запропонуй розумні варіанти й чітко познач їх як припущення'}\n\nБЕКЛОГ: ${backlog.map(b => `${b.title} (${b.kind}, ${b.st})`).join('; ') || 'порожній'}\n\nСХВАЛЕНІ ДОКУМЕНТИ КОМАНДИ («біблія гри»):\n${docs || 'поки немає'}`;
}

async function callClaude(env, { model, system, user, maxTokens, effort }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.__apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, output_config: { effort }, system, messages: [{ role: 'user', content: user }] })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${data?.error?.message || ''}`.slice(0, 200));
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return { text, cost: cost(data.model || model, data.usage), stop: data.stop_reason };
}
async function addSpend(env, usd) {
  if (!env.BUDGET || !usd) return;
  for (const k of ['spend:' + today(), 'agents:' + today()]) {
    const v = (Number(await env.BUDGET.get(k)) || 0) + usd;
    await env.BUDGET.put(k, String(v), { expirationTtl: 3 * 86400 });
  }
}
async function canSpend(env) {
  if (!env.BUDGET) return true;
  const total = Number(await env.BUDGET.get('spend:' + today())) || 0, ag = Number(await env.BUDGET.get('agents:' + today())) || 0;
  return total < Number(env.DAILY_BUDGET_USD || 0.5) && ag < Number(env.AGENTS_DAILY_USD || 0.3);
}

// Один крок команди за запуск: спершу перевірка Контролера (дешево), потім нова задача агента
export async function runAgents(db, env, now = Date.now()) {
  await ensureAgentSchema(db);
  if (!env.__apiKey) return { idle: 'немає ключа' };
  await db.prepare("UPDATE agent_tasks SET status = 'queued', locked = 0 WHERE status IN ('working') AND locked < ?").bind(now - LOCK_MS).run();
  if (!(await canSpend(env))) return { idle: 'бюджет' };
  const rev = await db.prepare("SELECT * FROM agent_tasks WHERE status = 'review' AND locked < ? ORDER BY id LIMIT 1").bind(now - LOCK_MS).first();
  if (rev) return controllerStep(db, env, rev, now);
  const t = await db.prepare("SELECT * FROM agent_tasks WHERE status = 'queued' ORDER BY id LIMIT 1").first();
  if (t) return workerStep(db, env, t, now);
  return { idle: 'немає задач' };
}
async function workerStep(db, env, t, now) {
  const lock = await db.prepare("UPDATE agent_tasks SET status = 'working', locked = ?, updated = ? WHERE id = ? AND status = 'queued'").bind(now, now, t.id).run();
  if (lock.meta && lock.meta.changes === 0) return { idle: 'зайнято' };
  const R = ROLES[t.role];
  const system = `${R.prompt}\nТвоя зона: ${R.job}.\nКомпанія: VLASTELIN, керівник — власник студії. Відповідай українською. Формат — документ у markdown (заголовки ##, списки, таблиці), конкретно і без води, до ~1200 слів. Наприкінці — розділ «Наступні кроки» (2–4 пункти) і, якщо треба, «Питання до керівника».`;
  const user = `${await gameContext(db)}\n\nЗАВДАННЯ №${t.id}: ${t.title}\n${t.brief}${t.feedback ? `\n\nЗАУВАЖЕННЯ ДО ПОПЕРЕДНЬОЇ ВЕРСІЇ (виправ їх):\n${t.feedback}\n\nПОПЕРЕДНЯ ВЕРСІЯ:\n${String(t.result).slice(0, 4000)}` : ''}`;
  try {
    const r = await callClaude(env, { model: env.MODEL || 'claude-sonnet-5-5', system, user, maxTokens: 8000, effort: 'medium' });
    await addSpend(env, r.cost);
    if (!r.text) throw new Error(r.stop === 'refusal' ? 'модель відмовилась' : 'порожня відповідь');
    await db.prepare("UPDATE agent_tasks SET status = 'review', result = ?, attempts = attempts + 1, cost = cost + ?, locked = 0, updated = ? WHERE id = ?").bind(r.text.slice(0, 20000), r.cost, Date.now(), t.id).run();
    return { worked: t.id, cost: r.cost };
  } catch (e) {
    await db.prepare("UPDATE agent_tasks SET status = 'queued', locked = ?, review = ?, updated = ? WHERE id = ?").bind(now, `Збій: ${String(e && e.message).slice(0, 200)} — повторю пізніше`, Date.now(), t.id).run();
    return { error: String(e && e.message) };
  }
}
async function controllerStep(db, env, t, now) {
  await db.prepare('UPDATE agent_tasks SET locked = ? WHERE id = ?').bind(now, t.id).run();
  const system = `${ROLES.controller.prompt}\nВідповідай ЛИШЕ JSON без markdown: {"verdict": "approve" або "rework", "score": ціле 1–10, "notes": "2–4 речення українською: що добре, що виправити"}. Обирай "rework", лише якщо є суттєві проблеми (оцінка < 7).`;
  const user = `${await gameContext(db)}\n\nРОЛЬ ВИКОНАВЦЯ: ${ROLES[t.role].name}\nЗАВДАННЯ: ${t.title}\n${t.brief}\n\nРЕЗУЛЬТАТ:\n${String(t.result).slice(0, 12000)}`;
  try {
    const r = await callClaude(env, { model: env.MODEL_FAST || 'claude-haiku-5-5', system, user, maxTokens: 1500, effort: 'low' });
    await addSpend(env, r.cost);
    let j = null; try { j = JSON.parse((r.text.match(/\{[\s\S]*\}/) || ['null'])[0]); } catch {}
    const score = Math.max(1, Math.min(10, Math.round(Number(j && j.score) || 7))), notes = String((j && j.notes) || 'Перевірено.').slice(0, 800);
    const rework = j && j.verdict === 'rework' && t.attempts <= MAX_REWORK;
    await db.prepare('UPDATE agent_tasks SET status = ?, review = ?, score = ?, feedback = ?, cost = cost + ?, locked = 0, updated = ? WHERE id = ?')
      .bind(rework ? 'queued' : 'ready', notes, score, rework ? notes : t.feedback, r.cost, Date.now(), t.id).run();
    return { reviewed: t.id, verdict: rework ? 'rework' : 'ready', score };
  } catch (e) {
    await db.prepare('UPDATE agent_tasks SET review = ?, updated = ? WHERE id = ?').bind(`Контролер: збій (${String(e && e.message).slice(0, 120)}), повторю`, Date.now(), t.id).run();
    return { error: String(e && e.message) };
  }
}

// Рішення керівника. Схвалена специфікація Програміста → GitHub issue з міткою agent (якщо підключено)
export async function decideTask(db, env, b = {}) {
  await ensureAgentSchema(db);
  const t = await db.prepare('SELECT * FROM agent_tasks WHERE id = ?').bind(Number(b.id) || 0).first();
  if (!t) return { status: 404, data: { error: 'Задачу не знайдено' } };
  const now = Date.now();
  if (b.decision === 'delete') {
    if (t.status === 'working') return { status: 409, data: { error: 'Агент саме працює над задачею — спробуйте за хвилину' } };
    await db.prepare('DELETE FROM agent_tasks WHERE id = ?').bind(t.id).run();
    return { status: 200, data: { ok: true } };
  }
  if (t.status !== 'ready') return { status: 409, data: { error: `Зараз задача має статус «${STATUS[t.status]}»` } };
  if (b.decision === 'rework') {
    const fb = String(b.comment || '').trim().slice(0, 1500);
    if (!fb) return { status: 400, data: { error: 'Напишіть, що виправити' } };
    await db.prepare("UPDATE agent_tasks SET status = 'queued', feedback = ?, review = '', updated = ? WHERE id = ?").bind('Від керівника: ' + fb, now, t.id).run();
    return { status: 200, data: { ok: true } };
  }
  if (b.decision !== 'approve') return { status: 400, data: { error: 'Невідоме рішення' } };
  let issue = '';
  if (t.role === 'programmer' && env.GH_TOKEN && env.GAME_REPO) {
    try { issue = await createIssue(env, t); } catch (e) { return { status: 502, data: { error: 'Не вдалося створити задачу в GitHub: ' + String(e && e.message).slice(0, 160) } }; }
  }
  await db.prepare("UPDATE agent_tasks SET status = 'done', issue = ?, updated = ? WHERE id = ?").bind(issue, now, t.id).run();
  return { status: 200, data: { ok: true, issue } };
}
async function createIssue(env, t) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GAME_REPO)) throw new Error('GAME_REPO має бути у форматі власник/репозиторій');
  const res = await fetch(`https://api.github.com/repos/${env.GAME_REPO}/issues`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'vlastelin-agents', 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `[Агент] ${t.title}`, labels: ['agent'],
      body: `Задача №${t.id} від Програміста VLASTELIN, схвалена керівником.\n\n${String(t.result).slice(0, 60000)}\n\n---\nОцінка Контролера: ${t.score || '—'}/10. ${t.review || ''}\n\n@claude Реалізуй цю специфікацію і відкрий PR. Не змінюй main напряму.` })
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${j.message || ''}`);
  return j.html_url || '';
}
