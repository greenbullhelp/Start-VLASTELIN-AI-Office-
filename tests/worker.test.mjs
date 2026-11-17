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
ok(sent.tools.length === 4 && sent.system.includes('Djek') && sent.system.includes('Властелін'), 'request built');
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
import { DatabaseSync } from 'node:sqlite';
// D1-compatible wrapper over a real in-memory SQLite (same SQL as production).
function memD1() {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    all: async () => ({ results: db.prepare(sql).all(...args).map(o => ({ ...o })) }),
    first: async () => { const o = db.prepare(sql).get(...args); return o ? { ...o } : null; }
  });
  return { prepare: sql => stmt(sql) };
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
// ===== Step 2: memory =====
const mem = (method, body, q = '') => new Request('https://w.dev/memory' + q, { method, headers: { Origin: O, 'Content-Type': 'application/json', 'X-Access-Code': 'secret' }, body: body ? JSON.stringify(body) : undefined });
r = await worker.fetch(mem('POST', { text: 'Керівник любить короткі звіти', category: 'preference' }), senv); j = await r.json(); ok(r.status === 200 && j.id > 0, 'memory added');
const mid = j.id;
r = await worker.fetch(mem('POST', { text: 'мій ключ sk-ant-abc' }), senv); ok(r.status === 400, 'secrets never stored in memory');
r = await worker.fetch(mem('PUT', { id: mid, text: 'Керівник любить дуже короткі звіти' }), senv); j = await r.json(); ok(r.status === 200, 'memory edited');
r = await worker.fetch(mem('GET'), senv); j = await r.json(); ok(j.memory.length === 1 && j.memory[0].text.includes('дуже') && j.memory[0].cat === 'preference', 'memory listed');
r = await worker.fetch(new Request('https://w.dev/memory', { headers: { Origin: O, 'X-Access-Code': 'bad' } }), senv); ok(r.status === 401, 'memory requires access code');
// Chat sees memory; server tools run on the worker; one API call when Claude already answered with text.
let apiCalls = 0, bodies = [];
const reply = (b, content, stop = 'tool_use') => new Response(JSON.stringify({ model: b.model, stop_reason: stop, content, usage: { input_tokens: 100, output_tokens: 10 } }), { status: 200 });
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('api.github.com')) return new Response(JSON.stringify(u.includes('/commits') ? [{ commit: { author: { date: '2026-11-17T10:00:00Z' }, message: 'Fix X' } }] : u.includes('/actions') ? { workflow_runs: [] } : { open_issues_count: 2, pushed_at: '2026-11-17T10:00:00Z' }), { status: 200 });
  apiCalls++; const b = JSON.parse(opts.body); bodies.push(b);
  const lastUser = b.messages[b.messages.length - 1];
  if (Array.isArray(lastUser.content) && lastUser.content[0].type === 'tool_result') return reply(b, [{ type: 'text', text: 'Аналіз: 2 відкриті задачі.' }], 'end_turn');
  const t = lastUser.content;
  if (t.includes('запам')) return reply(b, [{ type: 'text', text: 'Запам’ятав.' }, { type: 'tool_use', id: 'a', name: 'remember', input: { text: 'Офіс у Києві', category: 'fact' } }]);
  if (t.includes('забудь')) return reply(b, [{ type: 'tool_use', id: 'a', name: 'forget', input: { id: mid } }]);
  if (t.includes('GitHub')) return reply(b, [{ type: 'tool_use', id: 'g', name: 'github_status', input: {} }]);
  if (t.includes('ідеї')) return reply(b, [{ type: 'text', text: 'Є ідея.' }, { type: 'tool_use', id: 'p', name: 'propose', input: { title: 'Додати звіт тижня', details: 'Щопонеділка короткий звіт', section: 'analytics', cost: '~$0.05' } }, { type: 'tool_use', id: 'p2', name: 'propose', input: { title: 'Ремонт', details: 'x', section: 'nowhere', cost: '$1' } }]);
  return reply(b, [{ type: 'text', text: 'ok' }], 'end_turn');
};
r = await worker.fetch(mk({ 'X-Access-Code': 'secret' }, { messages: [{ role: 'user', content: 'запам’ятай: офіс у Києві' }], context: { tasks: [{ section: 'dev', title: 'Нова кнопка', status: 'new' }] } }), senv); j = await r.json();
ok(apiCalls === 1 && j.reply === 'Запам’ятав.' && j.notes[0].type === 'remember' && j.changed.memory, 'remember: executed on server, one API call');
ok(bodies[0].system.includes('Керівник любить дуже короткі звіти') && bodies[0].system.includes('[Розробка] Нова кнопка') && bodies[0].tools.length === 7, 'prompt has memory, tasks and all tools');
r = await worker.fetch(mem('GET'), senv); j = await r.json(); ok(j.memory.length === 2, 'memory persisted from chat');
apiCalls = 0; r = await worker.fetch(mk({ 'X-Access-Code': 'secret' }, { messages: [{ role: 'user', content: 'забудь про звіти' }] }), senv); j = await r.json();
ok(apiCalls === 1 && j.reply.includes('Забув') && j.notes[0].type === 'forget', 'forget without text gets a reply, no second call');
r = await worker.fetch(mem('DELETE', null, '?id=999'), senv); ok(r.status === 400, 'delete unknown memory -> error');
// ===== Step 3: analysis (GitHub read-only) =====
apiCalls = 0; bodies = [];
r = await worker.fetch(mk({ 'X-Access-Code': 'secret' }, { messages: [{ role: 'user', content: 'Що з GitHub?' }] }), senv); j = await r.json();
ok(apiCalls === 2 && j.reply.includes('2 відкриті') && JSON.stringify(bodies[1].messages).includes('Fix X'), 'github_status read and fed back to Claude');
// ===== Step 4: proposals =====
apiCalls = 0; r = await worker.fetch(mk({ 'X-Access-Code': 'secret' }, { messages: [{ role: 'user', content: 'дай ідеї' }] }), senv); j = await r.json();
ok(apiCalls === 1 && j.notes.filter(n => n.type === 'propose').length === 2 && j.changed.proposals, 'proposals created by chat');
const pr = (method, body) => new Request('https://w.dev/proposals', { method, headers: { Origin: O, 'Content-Type': 'application/json', 'X-Access-Code': 'secret' }, body: body ? JSON.stringify(body) : undefined });
r = await worker.fetch(pr('GET'), senv); j = await r.json();
ok(j.proposals.length === 2 && j.proposals.every(p => p.status === 'new') && j.proposals.some(p => p.section === 'business'), 'proposals listed, unknown section -> business');
const p1 = j.proposals.find(p => p.title === 'Додати звіт тижня');
r = await worker.fetch(mk({ 'X-Access-Code': 'secret' }, { messages: [{ role: 'user', content: 'дай ідеї' }] }), senv);
r = await worker.fetch(pr('GET'), senv); j = await r.json(); ok(j.proposals.length === 2, 'duplicate open proposal not added');
r = await worker.fetch(pr('POST', { id: p1.id, decision: 'approved' }), senv); j = await r.json(); ok(r.status === 200 && j.proposal.status === 'approved' && j.proposal.section === 'analytics', 'proposal approved');
r = await worker.fetch(pr('POST', { id: p1.id, decision: 'rejected' }), senv); ok(r.status === 409, 'decision is final');
r = await worker.fetch(pr('POST', { id: p1.id, decision: 'delete' }), senv); ok(r.status === 400, 'bad decision rejected');
r = await worker.fetch(pr('PUT', {}), senv); ok(r.status === 405, 'proposals: wrong method');
