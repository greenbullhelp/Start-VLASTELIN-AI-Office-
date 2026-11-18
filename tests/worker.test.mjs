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
ok(bodies[0].system.includes('Керівник любить дуже короткі звіти') && bodies[0].system.includes('[Розробка сайту] Нова кнопка') && bodies[0].tools.length === 11 && bodies[0].tools.some(t => t.name === 'trader_report') && bodies[0].tools.some(t => t.name === 'trader_teach'), 'prompt has memory, tasks and all tools');
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
// ===== Office summary from new sections reaches the prompt =====
bodies = [];
r = await worker.fetch(mk({ 'X-Access-Code': 'secret' }, { messages: [{ role: 'user', content: 'привіт' }], context: { summary: 'Фінанси: баланс 1 000 ₴' } }), senv); j = await r.json();
ok(bodies[0].system.includes('Зведення розділів офісу:\nФінанси: баланс 1 000 ₴'), 'office summary in prompt');
ok(bodies[0].tools.find(t => t.name === 'propose').input_schema.properties.section.enum.includes('legal'), 'new sections allowed for proposals');
// ===== Trader XAU (paper trading, order flow) =====
const T = await import('../worker/trader.js');
const cfg = T.cleanCfg({});
ok(T.cleanCfg({ risk: 50, stack: 2.6, minRR: 9, rr: 2 }).risk === 5 && T.cleanCfg({ stack: 2.6 }).stack === 3 && T.cleanCfg({ minRR: 9, rr: 2 }).minRR === 2, 'trader cfg clamped');
const vp = T.profile([{ l: 100, h: 110, v: 10 }, { l: 104, h: 106, v: 100 }, { l: 100, h: 101, v: 1 }]);
ok(vp.poc >= 104 && vp.poc <= 106 && vp.val >= 103.8 && vp.vah <= 106.2, 'volume profile POC / value area');
ok(T.vwap([{ h: 10, l: 10, c: 10, v: 1 }, { h: 20, l: 20, c: 20, v: 3 }]).v === 17.5, 'vwap');
const fp = T.addTrades({}, [100, 100.5, 101, 101.5].flatMap((p, i) => [{ p, q: 10, buy: true, t: 6e5 + i }, { p: p - .5, q: 1, buy: false, t: 6e5 + i }]).concat([{ p: 101, q: 25, buy: true, t: 6e5 + 9 }]), cfg);
const imb = T.imbalances(fp.bars[6e5], 3);
ok(imb.buyStack >= 3 && imb.sellStack === 0, 'stacked buy imbalances found');
ok(fp.big.length === 1 && fp.big[0].q === 25 && fp.big[0].buy, 'big trades >= bigLot recorded');
const bar = { t: 6e5, o: 100.4, h: 102, l: 99.9, c: 101.6, v: 50, bv: 40 };
const levels = [{ p: 100, n: 'POC 1H', w: 2, kind: 'poc' }, { p: 106, n: 'VAH 1H', w: 2, kind: 'vah' }];
let su = T.findSetup({ bias: .6, levels, bar, fpBar: fp.bars[6e5], big: fp.big, c15: [{ v: 10, bv: 8 }], atr5: 1, cfg, price: 101.6 });
ok(su.dir === 1 && su.setup === 'pull' && su.sl < 100 && su.rMul === 2 && Math.abs(su.tp - (101.6 + 2 * (101.6 - su.sl))) < 1e-9 && su.tgtWhy.includes('VAH 1H') && su.why.includes('POC 1H'), 'long setup; 2R chosen because VAH 1H blocks the way to 3R');
ok(su.factors.length >= 8 && su.factors[0].startsWith('Чому ЛОНГ') && su.factors.some(f => f.startsWith('Потік ордерів')) && su.factors.some(f => f.startsWith('Фундамент')), 'entry explained with factors');
su = T.findSetup({ bias: .6, levels: [levels[0]], bar, fpBar: fp.bars[6e5], big: fp.big, c15: [{ v: 10, bv: 8 }], atr5: 1, cfg, price: 101.6 });
ok(su.dir === 1 && su.rMul === 3, 'free path -> 3R target');
ok(T.chooseTarget({ dir: 1, entry: 100, sl: 99, levels: [{ p: 101.5, n: 'POC 4H', w: 3, kind: 'poc' }], zones: [], cfg }).skip, 'strong level before 2R -> skip trade');
ok(T.chooseTarget({ dir: 1, entry: 100, sl: 99, levels: [], zones: [], cfg, learn: { n: 10, p2: .6, p3: .2 } }).rMul === 2, 'learning: history favours 2R');
ok(T.chooseTarget({ dir: 1, entry: 100, sl: 99, levels: [], zones: [], cfg, learn: { n: 10, p2: .6, p3: .5 } }).rMul === 3, 'learning: history favours 3R');
ok(T.chooseTarget({ dir: -1, entry: 100, sl: 101, levels: [], zones: [], cfg, news: { t: Date.now() + 36e5, title: 'CPI' } }).rMul === 2, 'upcoming news -> 2R');
// resistance-zone reversal (short) and midpoint reversal
const zl = [{ p: 110, n: 'VAH 1H', w: 2, kind: 'vah' }, { p: 110.3, n: 'VWAP +1σ', w: 1.5, kind: 'vwap' }, { p: 104, n: 'MID VA 1H', w: 2, kind: 'mid' }];
const zones = T.buildZones(zl, .5);
ok(zones.length === 1 && zones[0].count === 2 && zones[0].lo === 110, 'zone from clustered levels');
const sfp = T.addTrades({}, [111, 110.5, 110, 109.5].flatMap((p, i) => [{ p, q: 10, buy: false, t: 9e5 + i }, { p: p + .5, q: 1, buy: true, t: 9e5 + i }]), cfg);
const sbar = { t: 9e5, o: 109.6, h: 111, l: 109.2, c: 109.4, v: 50, bv: 10 };
su = T.findSetup({ bias: .2, levels: zl, zones, bar: sbar, fpBar: sfp.bars[9e5], big: [], c15: [], atr5: 1, cfg, price: 109.4 });
ok(su.dir === -1 && su.setup === 'zone' && su.factors[0].includes('зони опору') && su.factors[0].includes('VAH 1H'), 'short reversal from resistance zone explained');
const mfp = T.addTrades({}, [104.5, 104, 103.5, 103].flatMap((p, i) => [{ p, q: 10, buy: false, t: 12e5 + i }, { p: p + .5, q: 1, buy: true, t: 12e5 + i }]), cfg);
su = T.findSetup({ bias: -.1, levels: zl, zones: [], bar: { t: 12e5, o: 103.4, h: 104.4, l: 103, c: 103.2, v: 40, bv: 8 }, fpBar: mfp.bars[12e5], big: [], c15: [], atr5: 1, cfg, price: 103.2 });
ok(su.dir === -1 && su.setup === 'mid' && su.why.includes('MID VA 1H'), 'short reversal from midpoint');
su = T.findSetup({ bias: .6, levels, bar, fpBar: fp.bars[6e5], big: fp.big, c15: [], atr5: 1, cfg, price: 101.6, cal: [{ t: Date.now() + 6e5, title: 'Non-Farm Payrolls', impact: 'high' }] });
ok(su.dir === 0 && su.why.includes('Non-Farm'), 'no entries right before high-impact news');
su = T.findSetup({ bias: .6, levels, bar, fpBar: fp.bars[6e5], big: fp.big, c15: [], atr5: 1, cfg, price: 101.6, fund: { bias: -.8, summary: 'долар росте' } });
ok(su.dir === 0 && su.why.includes('фундамент проти'), 'fundamental filter blocks long against strong bearish fundamentals');
su = T.findSetup({ bias: .1, levels, bar, fpBar: fp.bars[6e5], big: fp.big, c15: [], atr5: 1, cfg, price: 101.6 });
ok(su.dir === 0 && su.why.includes('нейтральний'), 'no trade on neutral bias');
su = T.findSetup({ bias: .6, levels, bar: { ...bar, bv: 10 }, fpBar: null, big: [], c15: [], atr5: 1, cfg, price: 101.6 });
ok(su.dir === 0 && su.why.includes('дельт'), 'no trade without delta confirmation');
// full cycle with a fake exchange: candles rising, then a trade at the target closes the position
const TDB = memD1(); let px = 3000, tid = 0;
const kl = (n, step) => Array.from({ length: n }, (_, i) => { const t = Date.now() - (n - i) * step, o = px - (n - i) * .2; return [t, String(o), String(o + 1), String(o - 1), String(o + .5), '100', t + step - 1, '0', 10, '70']; });
globalThis.fetch = async u => {
  u = String(u);
  if (u.includes('klines')) { const iv = new URL(u).searchParams.get('interval'); return new Response(JSON.stringify(kl(+new URL(u).searchParams.get('limit'), { '5m': 3e5, '15m': 9e5, '30m': 18e5, '1h': 36e5, '2h': 72e5, '4h': 144e5 }[iv]))); }
  if (u.includes('aggTrades')) return new Response(JSON.stringify([{ a: ++tid, p: String(px), q: '1', m: false, T: Date.now() }]));
  return new Response('{}', { status: 404 });
};
let tst = await T.runTrader(TDB);
ok(!tst.err && tst.an && tst.an.bias > 0 && tst.an.tfs.length === 6, 'trader cycle: analysis on 6 timeframes');
tst.pos = { dir: 1, qty: 1, entry: 2990, sl: 2980, tp: 2999, opened: Date.now(), riskUsd: 10, why: 'test' };
await TDB.prepare('UPDATE trader SET v = ? WHERE k = ?').bind(JSON.stringify(tst), 'st').run();
tst = await T.runTrader(TDB);
const tv = await T.traderView(TDB);
ok(!tv.pos && tv.trades.length === 1 && tv.trades[0].exitWhy === 'ціль' && tv.trades[0].mfe >= 0 && tv.stats.n === 1 && tv.stats.wins === 1 && tv.bal > 10000, 'position closed at target, stats updated');
const tenv = { ...env, DB: TDB };
const trq = (method, body, h = { 'X-Access-Code': 'secret' }) => new Request('https://w.dev/trader', { method, headers: { Origin: O, 'Content-Type': 'application/json', ...h }, body: body ? JSON.stringify(body) : undefined });
r = await worker.fetch(trq('GET', null, { 'X-Access-Code': 'bad' }), tenv); ok(r.status === 401, 'trader requires access code');
r = await worker.fetch(trq('POST', { action: 'config', cfg: { risk: 2, bigLot: 50 } }), tenv); j = await r.json(); ok(j.ok, 'trader config saved');
r = await worker.fetch(trq('POST', { action: 'stop' }), tenv);
r = await worker.fetch(trq('GET'), tenv); j = await r.json(); ok(j.cfg.risk === 2 && j.cfg.bigLot === 50 && j.cfg.on === false && j.stats.n === 1, 'trader view via route');
r = await worker.fetch(trq('POST', { action: 'reset' }), tenv); r = await worker.fetch(trq('GET'), tenv); j = await r.json(); ok(j.trades.length === 0 && j.bal === 10000 && j.cfg.risk === 2, 'trader reset keeps settings');
r = await worker.fetch(trq('POST', { action: 'hack' }), tenv); ok(r.status === 400, 'unknown trader action rejected');
ok((await T.traderReport(TDB)).includes('Трейдер XAU'), 'trader report text for Vlastelin');
let tt = await T.traderTeach(TDB, { lesson: 'Заходжу на розворот від мід-поінта та зони опору', cfg: { sPull: false, rr: 3, stack: 2 } });
r = await worker.fetch(trq('GET'), tenv); j = await r.json();
ok(tt.includes('урок №1') && j.lessons.length === 1 && j.cfg.sPull === false && j.cfg.stack === 2 && j.log[0].text.startsWith('Тренер:'), 'coach saves lesson and settings, logged');
r = await worker.fetch(trq('POST', { action: 'lesson-del', id: 1 }), tenv); r = await worker.fetch(trq('GET'), tenv); j = await r.json(); ok(j.lessons.length === 0, 'lesson deleted');
r = await worker.fetch(new Request('https://w.dev/trader?trades=50', { headers: { Origin: O, 'X-Access-Code': 'secret' } }), tenv); j = await r.json(); ok(Array.isArray(j.trades), 'trade history route');
// old trades table (from v1) gets new columns
const ODB = memD1(); await ODB.prepare('CREATE TABLE trades (id INTEGER PRIMARY KEY AUTOINCREMENT, dir INTEGER NOT NULL, qty REAL NOT NULL, entry REAL NOT NULL, sl REAL NOT NULL, tp REAL NOT NULL, exit REAL NOT NULL, opened INTEGER NOT NULL, closed INTEGER NOT NULL, pnl REAL NOT NULL, r REAL NOT NULL, why TEXT NOT NULL, exitWhy TEXT NOT NULL)').run();
await ODB.prepare("INSERT INTO trader (k, v) VALUES ('x','y')").run().catch(() => {});
await T.ensureTraderSchema(ODB); const cols = (await ODB.prepare('PRAGMA table_info(trades)').all()).results.map(c => c.name);
ok(['setup', 'factors', 'rmul', 'mfe', 'tgtWhy'].every(c => cols.includes(c)), 'trades table migrated');
// Fundamental brief: Claude + web search, saved for the trader, budget counted
let fundReq = null;
globalThis.fetch = async (u, o) => {
  if (String(u).includes('api.anthropic.com')) { fundReq = JSON.parse(o.body); return new Response(JSON.stringify({ model: 'claude-haiku-5-5', stop_reason: 'end_turn', usage: { input_tokens: 20000, output_tokens: 300, server_tool_use: { web_search_requests: 2 } },
    content: [{ type: 'text', text: 'Ось огляд: {"bias": -0.4, "summary": "Долар зміцнюється після сильних даних.", "drivers": ["− DXY росте", "+ геополітика"], "risks": ["CPI США"]}' }] })); }
  return new Response('{}', { status: 404 });
};
const fkv = new Map(); const fenv = { ...tenv, BUDGET: { get: async k => fkv.get(k) ?? null, put: async (k, v) => { fkv.set(k, v); } } };
r = await worker.fetch(trq('POST', { action: 'fund' }), fenv); j = await r.json();
ok(r.status === 200 && j.fund.bias === -0.4 && j.fund.drivers.length === 2 && fundReq.tools[0].type.startsWith('web_search') && fundReq.tools[0].max_uses === 3, 'fundamental brief via web search saved');
ok([...fkv.values()].some(v => Number(v) > 0.02), 'fundamental brief cost counted in daily budget');
r = await worker.fetch(trq('POST', { action: 'fund' }), fenv); ok(r.status === 429, 'fundamental refresh rate-limited');
r = await worker.fetch(trq('GET'), fenv); j = await r.json(); ok(j.fund && j.fund.summary.includes('Долар'), 'fundamentals in trader view');
// Data sources: Binance/Bybit blocked in the cloud -> OKX; spot XAUUSD (FOREX.com) basis
{
  const SDB = memD1(); const base = Date.now() - 300 * 3e5; const okxC = n => Array.from({ length: n }, (_, i) => { const t = base + i * 3e5; return [String(t), '3000', '3001', '2999', '3000.5', '100', '0.1', '300', '1']; });
  globalThis.fetch = async u => {
    u = String(u);
    if (u.includes('binance') || u.includes('bybit')) return new Response('{}', { status: 403 });
    if (u.includes('okx.com/api/v5/market/candles')) return new Response(JSON.stringify({ code: '0', data: okxC(+new URL(u).searchParams.get('limit')).reverse() }));
    if (u.includes('okx.com/api/v5/market/trades')) return new Response(JSON.stringify({ code: '0', data: [{ px: '3000.5', sz: '30000', side: 'buy', ts: String(Date.now()) }] }));
    if (u.includes('gold-api')) return new Response(JSON.stringify({ price: 2996.5, updatedAt: new Date().toISOString() }));
    return new Response('{}', { status: 429 });
  };
  const s1 = await T.runTrader(SDB);
  ok(!s1.err && s1.src === 'okx' && s1.srcErr.binance && s1.srcErr.bybit, 'blocked Binance/Bybit -> falls back to OKX');
  ok(s1.fp.big.length === 1 && s1.fp.big[0].q === 30, 'OKX contracts converted to ounces (big trade 30 oz)');
  ok(s1.an.spot === 2996.5 && s1.an.basis === -4, 'spot XAUUSD (FOREX.com) and basis');
  ok(s1.calErr.includes('429'), 'ForexFactory 429 noted, retried later');
  await saveFundForTest(SDB);
  const v1 = await T.traderView(SDB);
  ok(v1.cal.length === 1 && v1.calSrc.includes('Claude') && v1.srcName === 'OKX', 'calendar falls back to ForexFactory events from the Claude brief');
  su = T.findSetup({ bias: .6, levels, bar, fpBar: fp.bars[6e5], big: fp.big, c15: [], atr5: 1, cfg, price: 101.6, basis: -4 });
  ok(su.factors.some(f => f.includes('FOREX.com') && f.includes('97.60')), 'entry also shown in FOREX.com prices');
}
async function saveFundForTest(db) { await T.saveFund(db, { at: Date.now(), bias: 0, summary: 's', drivers: [], risks: [], events: [{ t: Date.now() + 36e5, title: 'CPI m/m', impact: 'high' }] }); }
// Agent team (game department): assign -> worker agent -> Controller -> owner decision -> GitHub issue
{
  const A = await import('../worker/agents.js');
  const ADB = memD1(); const akv = new Map(); const ABUD = { get: async k => akv.get(k) ?? null, put: async (k, v) => { akv.set(k, v); } };
  const aenv = { ...env, DB: ADB, BUDGET: ABUD, __apiKey: 'k' };
  await ADB.prepare('CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT, t INTEGER)').run();
  await ADB.prepare('INSERT INTO state (k, v, t) VALUES (?, ?, ?)').bind('ws', JSON.stringify({ game: { concept: { name: 'Зоряна Кузня', genre: 'стратегія' } } }), 1).run();
  let calls = [], verdict = 'rework', issues = [];
  globalThis.fetch = async (u, o) => {
    u = String(u); const b = JSON.parse(o.body);
    if (u.includes('api.github.com')) { issues.push({ u, b, auth: o.headers.Authorization }); return new Response(JSON.stringify({ html_url: 'https://github.com/x/game/issues/1' }), { status: 201 }); }
    calls.push(b);
    const ctrl = b.system.includes('Контролер');
    return new Response(JSON.stringify({ model: b.model, stop_reason: 'end_turn', usage: { input_tokens: 2000, output_tokens: ctrl ? 100 : 3000 },
      content: [{ type: 'text', text: ctrl ? JSON.stringify({ verdict, score: verdict === 'rework' ? 5 : 8, notes: verdict === 'rework' ? 'Мало конкретики' : 'Добре' }) : '## Сюжет\nТекст версії ' + calls.length }] }));
  };
  ok((await A.assignTask(ADB, { role: 'controller', title: 'x', brief: 'y' })).error, 'controller cannot be assigned work');
  const t1 = await A.assignTask(ADB, { role: 'scenarist', title: 'Сюжет гри', brief: 'Придумай сюжет' });
  ok(t1.id === 1 && t1.name === 'Сценарист', 'task assigned to scenarist');
  let s = await A.runAgents(ADB, aenv);
  ok(s.worked === 1 && calls[0].model === 'claude-sonnet-5-5' && calls[0].messages[0].content.includes('Зоряна Кузня') && calls[0].system.includes('Сценарист'), 'agent works with game concept');
  s = await A.runAgents(ADB, aenv);
  ok(s.reviewed === 1 && s.verdict === 'rework' && calls[1].model === 'claude-haiku-5-5', 'Controller (Haiku) sends weak result back');
  s = await A.runAgents(ADB, aenv);
  ok(s.worked === 1 && calls[2].messages[0].content.includes('Мало конкретики'), 'agent reworks with Controller notes');
  verdict = 'approve'; s = await A.runAgents(ADB, aenv);
  let v = await A.teamView(ADB, aenv);
  ok(s.verdict === 'ready' && v.tasks[0].status === 'ready' && v.tasks[0].score === 8, 'approved by Controller -> waits for owner');
  ok(v.budget.spent > 0 && Number(akv.get('spend:' + new Date().toISOString().slice(0, 10))) > 0, 'agent spend counted in both budgets');
  ok((await A.runAgents(ADB, aenv)).idle, 'idle when nothing to do (no API call)');
  let d = await A.decideTask(ADB, aenv, { id: 1, decision: 'rework' }); ok(d.status === 400, 'owner rework needs a comment');
  d = await A.decideTask(ADB, aenv, { id: 1, decision: 'rework', comment: 'Додай злодія' }); ok(d.status === 200, 'owner sends back');
  await A.runAgents(ADB, aenv); await A.runAgents(ADB, aenv);
  ok(calls.at(-2).messages[0].content.includes('Додай злодія'), 'owner feedback reaches agent');
  d = await A.decideTask(ADB, aenv, { id: 1, decision: 'approve' }); ok(d.status === 200 && !d.data.issue && issues.length === 0, 'approved; non-programmer -> no GitHub issue');
  await A.assignTask(ADB, { role: 'economist', title: 'Валюти', brief: 'Економіка' }); await A.runAgents(ADB, aenv);
  ok(calls.at(-1).messages[0].content.includes('Сценарист: Сюжет гри'), 'approved docs form the game bible for next agents');
  await A.runAgents(ADB, aenv);
  const t3 = await A.assignTask(ADB, { role: 'programmer', title: 'Ядро гри', brief: 'Архітектура' }); await A.runAgents(ADB, aenv); await A.runAgents(ADB, aenv);
  d = await A.decideTask(ADB, { ...aenv, GH_TOKEN: 'ghp_x', GAME_REPO: 'x/game' }, { id: t3.id, decision: 'approve' });
  ok(d.status === 200 && d.data.issue.includes('/issues/1') && issues[0].u.includes('/repos/x/game/issues') && issues[0].b.labels[0] === 'agent' && issues[0].b.body.includes('@claude'), 'programmer spec -> GitHub issue with label agent');
  ok((await A.decideTask(ADB, aenv, { id: t3.id, decision: 'approve' })).status === 409, 'decision is final');
  akv.set('agents:' + new Date().toISOString().slice(0, 10), '5');
  await A.assignTask(ADB, { role: 'designer', title: 'UI', brief: 'Екрани' });
  const nb = calls.length; ok((await A.runAgents(ADB, aenv)).idle === 'бюджет' && calls.length === nb, 'daily agent budget stops work');
  // routes + chat tool
  const wenv = { ...env, DB: ADB, BUDGET: ABUD };
  const tq = (m, body) => new Request('https://w.dev/team', { method: m, headers: { Origin: O, 'X-Access-Code': 'secret', 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  r = await worker.fetch(new Request('https://w.dev/team', { headers: { Origin: O } }), wenv); ok(r.status === 401, 'team route protected');
  r = await worker.fetch(tq('GET'), wenv); j = await r.json(); ok(r.status === 200 && j.roles.length === 5 && j.tasks.length === 4 && !j.roles[0].prompt, 'team view');
  r = await worker.fetch(tq('POST', { action: 'assign', role: 'designer', title: 'Логотип', brief: 'Опис' }), wenv); ok(r.status === 200, 'assign from site');
  globalThis.fetch = async (u, o) => { const b = JSON.parse(o.body); calls.push(b); return new Response(JSON.stringify({ model: b.model, stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'text', text: 'Доручив.' }, { type: 'tool_use', id: 'a', name: 'assign_task', input: { role: 'economist', title: 'Ціни магазину', brief: 'Таблиця цін' } }] })); };
  akv.clear();
  r = await worker.fetch(mk({ 'X-Access-Code': 'secret' }, { messages: [{ role: 'user', content: 'Нехай економіст порахує ціни' }] }), wenv); j = await r.json();
  ok(j.notes.some(n => n.type === 'assign') && j.changed.team && calls.at(-1).system.includes('ВІДДІЛ ГРИ'), 'Vlastelin assigns task via chat');
}
