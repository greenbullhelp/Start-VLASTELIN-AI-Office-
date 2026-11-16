/**
 * VLASTELIN AI-агент — сервер-посередник (Cloudflare Worker)
 *
 * Тримає ключ Claude API у секреті, приймає запити лише з вашого сайту
 * і (за бажанням) лише з правильним кодом доступу.
 *
 * Змінні середовища (Settings → Variables and Secrets):
 *   ANTHROPIC_API_KEY  — секрет, ключ з console.anthropic.com   (обов'язково)
 *   ACCESS_CODE        — секрет, ваш код доступу                 (рекомендовано)
 *   ALLOWED_ORIGINS    — https://greenbullhelp.github.io         (за замовчуванням саме він)
 *   MODEL              — модель Claude                           (за замовчуванням claude-sonnet-5-5)
 */

const DEFAULT_MODEL = 'claude-sonnet-5-5';
const MAX_HISTORY = 20;
const MAX_CHARS = 4000;

const TOOLS = [
  {
    name: 'create_project',
    description: 'Створити новий проєкт у центрі проєктів офісу.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Назва проєкту' },
        progress: { type: 'integer', minimum: 0, maximum: 100, description: 'Початковий прогрес у відсотках' }
      },
      required: ['name']
    }
  },
  {
    name: 'update_project_progress',
    description: 'Змінити прогрес наявного проєкту.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Назва наявного проєкту' },
        progress: { type: 'integer', minimum: 0, maximum: 100 }
      },
      required: ['name', 'progress']
    }
  },
  {
    name: 'add_event',
    description: 'Додати подію в календар на сьогодні.',
    input_schema: {
      type: 'object',
      properties: {
        time: { type: 'string', description: 'Час у форматі ГГ:ХХ' },
        title: { type: 'string', description: 'Назва події' }
      },
      required: ['time', 'title']
    }
  }
];

function systemPrompt(ctx = {}) {
  const projects = Array.isArray(ctx.projects) ? ctx.projects.slice(0, 50) : [];
  const events = Array.isArray(ctx.events) ? ctx.events.slice(0, 50) : [];
  return [
    `Ти — AI-асистент віртуального офісу VLASTELIN. Твій керівник: ${String(ctx.user || 'керівник').slice(0, 60)}.`,
    'Відповідай українською (або мовою керівника), коротко і по суті: 1–4 речення, без markdown-розмітки — відповідь показується в маленькій панелі й озвучується голосом.',
    'Ти можеш керувати офісом через інструменти: створювати проєкти, змінювати їх прогрес і додавати події в календар. Використовуй їх, коли керівник про це просить, і коротко підтверджуй дію.',
    'Якщо чогось не можеш зробити — чесно скажи і запропонуй, що можна зробити замість цього.',
    `Зараз: ${String(ctx.now || '').slice(0, 60)}. Місто: ${String(ctx.city || '').slice(0, 60)}.`,
    `Проєкти: ${projects.map(p => `${String(p.name).slice(0, 80)} (${p.progress | 0}%)`).join('; ') || 'немає'}.`,
    `Події сьогодні: ${events.map(e => `${String(e.t).slice(0, 5)} ${String(e.title).slice(0, 80)}`).join('; ') || 'немає'}.`
  ].join('\n');
}

function cleanMessages(list) {
  if (!Array.isArray(list)) return null;
  const msgs = list
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_HISTORY)
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();   // API вимагає починати з user
  const merged = [];                                              // і чергувати ролі
  for (const m of msgs) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += '\n' + m.content; else merged.push({ ...m });
  }
  return merged.length && merged[merged.length - 1].role === 'user' ? merged : null;
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
}

export default {
  async fetch(request, env) {
    const allowed = (env.ALLOWED_ORIGINS || 'https://greenbullhelp.github.io').split(',').map(s => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    const okOrigin = allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': okOrigin ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Access-Code',
      'Vary': 'Origin'
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname.endsWith('/health'))) {
      return json({ ok: true, service: 'vlastelin-agent', model: env.MODEL || DEFAULT_MODEL, protected: Boolean(env.ACCESS_CODE), configured: Boolean(env.ANTHROPIC_API_KEY) }, 200, cors);
    }
    if (request.method !== 'POST') return json({ error: 'Метод не підтримується' }, 405, cors);
    if (!okOrigin) return json({ error: 'Доступ дозволено лише з сайту офісу' }, 403, cors);
    if (env.ACCESS_CODE && request.headers.get('X-Access-Code') !== env.ACCESS_CODE) return json({ error: 'Невірний код доступу' }, 401, cors);
    if (!env.ANTHROPIC_API_KEY) return json({ error: 'На сервері не задано ANTHROPIC_API_KEY' }, 500, cors);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'Некоректний JSON' }, 400, cors); }
    const messages = cleanMessages(body.messages);
    if (!messages) return json({ error: 'Порожнє або некоректне повідомлення' }, 400, cors);

    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: env.MODEL || DEFAULT_MODEL, max_tokens: 1024, system: systemPrompt(body.context), tools: TOOLS, messages })
      });
    } catch (e) {
      return json({ error: 'Не вдалося зв\'язатися з Claude API' }, 502, cors);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return json({ error: data?.error?.message || `Claude API: помилка ${res.status}` }, 502, cors);

    const blocks = Array.isArray(data.content) ? data.content : [];
    const reply = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    const actions = blocks.filter(b => b.type === 'tool_use' && TOOLS.some(t => t.name === b.name)).map(b => ({ name: b.name, input: b.input || {} }));
    return json({ reply, actions, model: data.model, usage: data.usage }, 200, cors);
  }
};
