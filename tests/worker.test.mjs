import worker from '../worker/agent-worker.js';
let sent;
globalThis.fetch = async (url, opts) => { sent = JSON.parse(opts.body); return new Response(JSON.stringify({ model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Створив проєкт.' }, { type: 'tool_use', id: 't1', name: 'create_project', input: { name: 'Логістика', progress: 5 } }, { type: 'tool_use', id: 't2', name: 'hack', input: {} }], usage: {} }), { status: 200 }); };
const env = { ANTHROPIC_API_KEY: 'sk-ant-test-0123456789abcdefghij', ACCESS_CODE: 'secret' };
const O = 'https://greenbullhelp.github.io';
const mk = (h = {}, body) => new Request('https://w.dev/chat', { method: 'POST', headers: { Origin: O, 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) });
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
let r = await worker.fetch(new Request('https://w.dev/health', { headers: { Origin: O } }), env); let j = await r.json();
ok(r.status === 200 && j.protected && j.configured, 'health');
r = await worker.fetch(new Request('https://w.dev/chat', { method: 'OPTIONS', headers: { Origin: O } }), env); ok(r.status === 204 && r.headers.get('Access-Control-Allow-Origin') === O, 'preflight');
r = await worker.fetch(new Request('https://w.dev/chat', { method: 'POST', headers: { Origin: 'https://evil.com' }, body: '{}' }), env); ok(r.status === 403, 'foreign origin blocked');
r = await worker.fetch(mk({ 'X-Access-Code': 'bad' }, { messages: [{ role: 'user', content: 'hi' }] }), env); ok(r.status === 401, 'bad code blocked');
r = await worker.fetch(mk({ 'X-Access-Code': 'secret' }, { messages: [] }), env); ok(r.status === 400, 'empty rejected');
r = await worker.fetch(mk({ 'X-Access-Code': 'secret' }, { messages: [{ role: 'assistant', content: 'Привіт' }, { role: 'user', content: 'Створи проєкт Логістика' }, { role: 'user', content: 'швидко' }], context: { user: 'Djek', projects: [{ name: 'A', progress: 10 }], events: [] } }), env);
j = await r.json();
ok(r.status === 200 && j.reply === 'Створив проєкт.' && j.actions.length === 1 && j.actions[0].name === 'create_project', 'chat + actions filtered');
ok(sent.messages.length === 1 && sent.messages[0].role === 'user' && sent.messages[0].content.includes('швидко'), 'history normalized');
ok(sent.tools.length === 3 && sent.system.includes('Djek') && sent.system.includes('Властелін'), 'request built');
ok(sent.model === 'claude-haiku-5-5' && sent.output_config.effort === 'low' && sent.max_tokens === 1024 && j.tier === 'fast', 'simple task routed to Haiku, low effort');
ok(sent.system.includes('ПРАВИЛА БЕЗПЕКИ') && sent.system.includes('main') && sent.system.includes('ЕКОНОМІЯ ТОКЕНІВ'), 'rules in request');
r = await worker.fetch(mk({ 'X-Access-Code': 'secret' }, { messages: [{ role: 'user', content: 'Проаналізуй мої проєкти' }] }), env); j = await r.json();
ok(sent.model === 'claude-sonnet-5-5' && sent.output_config.effort === 'medium' && j.tier === 'smart', 'analysis routed to Sonnet');
r = await worker.fetch(mk({ 'X-Access-Code': 'secret' }, { messages: [{ role: 'user', content: 'привіт' }], mode: 'deep' }), env);
ok(sent.model === 'claude-sonnet-5-5', 'deep mode forces Sonnet');
const img = { media_type: 'image/jpeg', data: 'QUJDRA==' };
r = await worker.fetch(mk({ 'X-Access-Code': 'secret' }, { messages: [{ role: 'user', content: 'старе' }, { role: 'assistant', content: 'ок' }, { role: 'user', content: 'що на фото?' }], images: [img, { media_type: 'text/html', data: 'QQ==' }, { media_type: 'image/png', data: 'bad data!' }] }), env);
const lastMsg = sent.messages[sent.messages.length - 1];
ok(Array.isArray(lastMsg.content) && lastMsg.content.length === 2 && lastMsg.content[0].type === 'image' && lastMsg.content[0].source.data === 'QUJDRA==' && lastMsg.content[1].text === 'що на фото?' && typeof sent.messages[0].content === 'string', 'images attached to last message only, invalid ones dropped');
// Daily budget with an in-memory KV stand-in.
const kv = new Map(); const BUDGET = { get: async k => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } };
globalThis.fetch = async (url, opts) => { sent = JSON.parse(opts.body); return new Response(JSON.stringify({ model: sent.model, content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1_000_000, output_tokens: 0 } }), { status: 200 }); };
const benv = { ...env, BUDGET, DAILY_BUDGET_USD: '0.15' };
r = await worker.fetch(mk({ 'X-Access-Code': 'secret' }, { messages: [{ role: 'user', content: 'hi' }] }), benv); j = await r.json();
ok(r.status === 200 && Math.abs(j.cost - 0.10) < 1e-9 && Math.abs(j.budget.spent - 0.10) < 1e-9, 'cost counted ($0.10 for 1M Haiku input)');
r = await worker.fetch(mk({ 'X-Access-Code': 'secret' }, { messages: [{ role: 'user', content: 'hi' }] }), benv); j = await r.json();
let calls = 0; globalThis.fetch = async () => { calls++; return new Response('{}', { status: 200 }); };
r = await worker.fetch(mk({ 'X-Access-Code': 'secret' }, { messages: [{ role: 'user', content: 'hi' }] }), benv); j = await r.json();
ok(r.status === 429 && j.error.includes('ліміт') && calls === 0, 'daily budget blocks before calling the API');
globalThis.fetch = async () => new Response(JSON.stringify({ stop_reason: 'refusal', content: [] }), { status: 200 });
r = await worker.fetch(mk({ 'X-Access-Code': 'secret' }, { messages: [{ role: 'user', content: 'hi' }] }), env); j = await r.json();
ok(r.status === 200 && j.reply.includes('Не можу'), 'refusal gets an honest reply');
globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 });
r = await worker.fetch(mk({ 'X-Access-Code': 'secret' }, { messages: [{ role: 'user', content: 'hi' }] }), env); j = await r.json();
ok(r.status === 502 && j.error.includes('invalid'), 'upstream error passed');
r = await worker.fetch(mk({}, { messages: [{ role: 'user', content: 'hi' }] }), { ACCESS_CODE: 'secret' }); ok(r.status === 401, 'code required before key check');
let hdr; globalThis.fetch = async (url, opts) => { hdr = opts.headers['x-api-key']; return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 }); };
r = await worker.fetch(mk({ 'X-Access-Code': 'secret' }, { messages: [{ role: 'user', content: 'hi' }] }), { ...env, ANTHROPIC_API_KEY: ' sk-ant-api03-abcdefghij​_KLMNOPQRST-xyz\r\n' }); ok(r.status === 200 && hdr === 'sk-ant-api03-abcdefghij_KLMNOPQRST-xyz', 'key whitespace trimmed');
r = await worker.fetch(mk({ 'X-Access-Code': 'secret' }, { messages: [{ role: 'user', content: 'hi' }] }), { ...env, ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY="sk-ant-api03-abcdefghij KLMNOPQRST"' }); ok(r.status === 200 && hdr === 'sk-ant-api03-abcdefghijKLMNOPQRST', 'key prefix and quotes stripped');
const origErr = console.error; console.error = () => {};
r = await worker.fetch(mk({ 'X-Access-Code': 'secret' }, { messages: [{ role: 'user', content: 'hi' }] }), { ...env, ANTHROPIC_API_KEY: 'мій ключ' }); j = await r.json(); ok(r.status === 500 && j.error.includes('формат'), 'bad key reported');
console.error = origErr;
// ===== Shared storage (/state) with an in-memory D1 stand-in =====
function memD1() {
  const rows = new Map();
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    run: async () => {
      if (sql.startsWith('INSERT')) { const [k, v, t] = args; const cur = rows.get(k); if (!cur || t >= cur.t) rows.set(k, { v, t }); }
      return { success: true };
    },
    all: async () => ({ results: [...rows].map(([k, r]) => ({ k, ...r })) }),
    first: async () => { const r = rows.get(args[0]); return r ? { ...r } : null; }
  });
  return { prepare: sql => stmt(sql), rows };
}
const DB = memD1(); const senv = { ...env, DB };
const st = (method, body, h = { 'X-Access-Code': 'secret' }) => new Request('https://w.dev/state', { method, headers: { Origin: O, 'Content-Type': 'application/json', ...h }, body: body ? JSON.stringify(body) : undefined });
r = await worker.fetch(st('GET', null, { 'X-Access-Code': 'bad' }), senv); ok(r.status === 401, 'state requires access code');
r = await worker.fetch(st('GET'), senv); j = await r.json(); ok(r.status === 200 && Object.keys(j.state).length === 0, 'empty state');
r = await worker.fetch(st('PUT', { key: 'projects', v: '[{"name":"A","progress":5}]', t: 1000 }), senv); j = await r.json();
ok(r.status === 200 && j.applied && j.t === 1000, 'state saved');
r = await worker.fetch(st('PUT', { key: 'projects', v: '[{"name":"old"}]', t: 900 }), senv); j = await r.json();
ok(j.applied === false && j.t === 1000 && j.v.includes('"A"'), 'older write rejected, newer value returned');
r = await worker.fetch(st('GET'), senv); j = await r.json(); ok(j.state.projects.t === 1000 && JSON.parse(j.state.projects.v)[0].name === 'A', 'state read back');
r = await worker.fetch(st('PUT', { key: 'secrets', v: '{}', t: 5 }), senv); ok(r.status === 400, 'unknown key rejected');
r = await worker.fetch(st('PUT', { key: 'events', v: 'not json', t: 5 }), senv); ok(r.status === 400, 'non-JSON rejected');
r = await worker.fetch(st('PUT', { key: 'events', v: JSON.stringify('x'.repeat(300 * 1024)), t: 5 }), senv); ok(r.status === 413, 'oversized rejected');
r = await worker.fetch(st('GET'), env); ok(r.status === 503, 'no DB binding -> honest 503');
r = await worker.fetch(new Request('https://w.dev/health', { headers: { Origin: O } }), senv); j = await r.json(); ok(j.storage === true, 'health reports storage');
