// Трейдер XAU — паперова торгівля XAU/USDT за потоком ордерів.
// Аналіз зверху вниз 4H → 2H → 1H → 30M → 15M → 5M; вхід на закритті 5M з підтвердженням 15M.
// Інструменти: VWAP, Volume Profile (POC/VAH/VAL, HVN/LVN), Cumulative Volume Delta, футпрінт (імбаланси), великі угоди.
// Усе — детермінований код (без ШІ): дешево, швидко і перевірювано. Реальних ордерів тут немає.

export const TFS = ['4h', '2h', '1h', '30m', '15m', '5m'];
const TF_MS = { '4h': 144e5, '2h': 72e5, '1h': 36e5, '30m': 18e5, '15m': 9e5, '5m': 3e5 };
const LIMIT = { '4h': 120, '2h': 120, '1h': 200, '30m': 120, '15m': 120, '5m': 300 };
const LOOK = { '4h': 60, '2h': 60, '1h': 72, '30m': 96, '15m': 96, '5m': 144 };   // свічок для профілю обсягу
const WEIGHT = { '4h': 3, '2h': 2, '1h': 2, '30m': 1 };                           // вага старших ТФ в ухилі
const BAR = 3e5;   // 5 хв

export const DEFAULT_CFG = { on: true, start: 10000, risk: 1, rr: 2, minRR: 1.5, bigLot: 20, imbRatio: 3, stack: 3, tick: 0.5, fee: 0.04, bias: 0.3, tolAtr: 0.3 };
const CFG_LIMITS = { start: [100, 1e7], risk: [0.1, 5], rr: [1, 6], minRR: [1, 5], bigLot: [0.1, 1000], imbRatio: [1.5, 10], stack: [2, 8], tick: [0.1, 5], fee: [0, 0.3], bias: [0.05, 0.9], tolAtr: [0.05, 1.5] };
export function cleanCfg(input = {}, base = DEFAULT_CFG) {
  const c = { ...base };
  for (const [k, [lo, hi]] of Object.entries(CFG_LIMITS)) {
    if (input[k] === undefined || input[k] === '') continue;
    const v = Number(input[k]);
    if (!Number.isFinite(v)) continue;
    c[k] = Math.min(hi, Math.max(lo, v));
  }
  if ('on' in input) c.on = Boolean(input.on);
  c.stack = Math.round(c.stack);
  if (c.minRR > c.rr) c.minRR = c.rr;
  return c;
}

/* ================= ДАНІ З БІРЖІ ================= */
async function getJ(u) {
  const r = await fetch(u, { headers: { 'User-Agent': 'vlastelin-trader' } });
  if (!r.ok) throw new Error(`${new URL(u).hostname} ${r.status}`);
  return r.json();
}
const BYBIT_IV = { '4h': 240, '2h': 120, '1h': 60, '30m': 30, '15m': 15, '5m': 5 };
export async function fetchCandles(tf, prefer = 'binance') {
  const binance = async () => (await getJ(`https://fapi.binance.com/fapi/v1/klines?symbol=XAUUSDT&interval=${tf}&limit=${LIMIT[tf]}`))
    .map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], bv: +r[9] }));
  // Bybit не дає обсягу покупців у свічці — оцінюємо його за тілом свічки (позначається як «наближено»)
  const bybit = async () => (await getJ(`https://api.bybit.com/v5/market/kline?category=linear&symbol=XAUUSDT&interval=${BYBIT_IV[tf]}&limit=${Math.min(LIMIT[tf], 1000)}`))
    .result.list.map(r => { const o = +r[1], h = +r[2], l = +r[3], c = +r[4], v = +r[5]; return { t: +r[0], o, h, l, c, v, bv: v * (.5 + .5 * (c - o) / ((h - l) || 1)), est: true }; }).reverse();
  if (prefer === 'bybit') { try { return { src: 'bybit', c: await bybit() }; } catch { return { src: 'binance', c: await binance() }; } }
  try { return { src: 'binance', c: await binance() }; } catch { return { src: 'bybit', c: await bybit() }; }
}
// Стрічка угод (для футпрінта й великих угод). buy = ініціатор — покупець.
export async function fetchTrades(src, lastId, lastT) {
  const out = [];
  if (src === 'binance') {
    let from = lastId ? lastId + 1 : null;
    for (let page = 0; page < 3; page++) {
      const a = await getJ('https://fapi.binance.com/fapi/v1/aggTrades?symbol=XAUUSDT&limit=1000' + (from ? `&fromId=${from}` : ''));
      for (const x of a) out.push({ id: x.a, p: +x.p, q: +x.q, buy: !x.m, t: x.T });
      if (a.length < 1000 || !from) break;
      from = a[a.length - 1].a + 1;
    }
    return out;
  }
  const j = await getJ('https://api.bybit.com/v5/market/recent-trade?category=linear&symbol=XAUUSDT&limit=1000');
  for (const x of j.result.list) { const t = +x.time; if (!lastT || t > lastT) out.push({ id: 0, p: +x.price, q: +x.size, buy: x.side === 'Buy', t }); }
  return out.sort((a, b) => a.t - b.t);
}

/* ================= ІНДИКАТОРИ ================= */
const delta = c => 2 * c.bv - c.v;
export function vwap(candles) {
  let pv = 0, v = 0, pv2 = 0;
  for (const c of candles) { const tp = (c.h + c.l + c.c) / 3; pv += tp * c.v; pv2 += tp * tp * c.v; v += c.v; }
  if (!v) return null;
  const m = pv / v;
  return { v: m, sd: Math.sqrt(Math.max(0, pv2 / v - m * m)) };
}
// Профіль обсягу зі свічок: обсяг рівномірно розподіляється по діапазону свічки
export function profile(candles, bins = 60) {
  if (!candles.length) return null;
  let lo = Infinity, hi = -Infinity;
  for (const c of candles) { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); }
  const step = (hi - lo) / bins || 1, vol = new Array(bins).fill(0);
  for (const c of candles) {
    const i0 = Math.max(0, Math.min(bins - 1, Math.floor((c.l - lo) / step))), i1 = Math.max(i0, Math.min(bins - 1, Math.floor((c.h - lo) / step)));
    const per = c.v / (i1 - i0 + 1);
    for (let i = i0; i <= i1; i++) vol[i] += per;
  }
  const px = i => lo + (i + .5) * step, total = vol.reduce((a, b) => a + b, 0);
  let poc = 0; vol.forEach((x, i) => { if (x > vol[poc]) poc = i; });
  let a = poc, b = poc, acc = vol[poc];
  while (acc < total * .7 && (a > 0 || b < bins - 1)) {
    const up = b < bins - 1 ? vol[b + 1] : -1, dn = a > 0 ? vol[a - 1] : -1;
    if (up >= dn) acc += vol[++b]; else acc += vol[--a];
  }
  const s = vol.map((_, i) => (vol[Math.max(0, i - 1)] + vol[i] + vol[Math.min(bins - 1, i + 1)]) / 3);
  const mean = total / bins, hvn = [], lvn = [];
  for (let i = 2; i < bins - 2; i++) {
    if (s[i] >= s[i - 1] && s[i] > s[i + 1] && s[i] >= 1.3 * mean && i !== poc) hvn.push(px(i));
    if (s[i] <= s[i - 1] && s[i] < s[i + 1] && s[i] <= .5 * mean && i >= a && i <= b) lvn.push(px(i));
  }
  return { poc: px(poc), vah: lo + (b + 1) * step, val: lo + a * step, hvn, lvn, step };
}
export function cvdInfo(candles, n = 10) {
  let cvd = 0; const line = candles.map(c => (cvd += delta(c)));
  const last = candles.slice(-n), prev = candles.slice(-2 * n, -n);
  const slope = last.reduce((s, c) => s + delta(c), 0);
  let div = '';
  if (prev.length === n) {
    const hiL = Math.max(...last.map(c => c.h)), hiP = Math.max(...prev.map(c => c.h)), loL = Math.min(...last.map(c => c.l)), loP = Math.min(...prev.map(c => c.l));
    const cL = line[line.length - 1], cP = line[line.length - 1 - n];
    if (hiL > hiP && cL < cP) div = 'bear';
    else if (loL < loP && cL > cP) div = 'bull';
  }
  return { cvd, slope, div };
}
export function atr(candles, n = 14) {
  const tr = candles.slice(-n - 1).map((c, i, a) => i ? Math.max(c.h - c.l, Math.abs(c.h - a[i - 1].c), Math.abs(c.l - a[i - 1].c)) : c.h - c.l).slice(1);
  return tr.length ? tr.reduce((a, b) => a + b, 0) / tr.length : 0;
}
const sgn = x => (x > 0 ? 1 : x < 0 ? -1 : 0);
export function analyzeTF(tf, candles, vw) {
  const look = candles.slice(-LOOK[tf]), pr = profile(look), cv = cvdInfo(look), price = candles[candles.length - 1].c;
  const score = sgn(price - vw.v) + sgn(price - pr.poc) + sgn(cv.slope);
  return { tf, price, vwap: vw.v, sd: vw.sd, poc: pr.poc, vah: pr.vah, val: pr.val, hvn: pr.hvn, lvn: pr.lvn, cvd: cv.slope, div: cv.div, score,
    bias: score >= 2 ? 'long' : score <= -2 ? 'short' : 'flat' };
}
// Загальний ухил старших ТФ: -1 (сильно вниз) … +1 (сильно вгору)
export function topDownBias(an) {
  let s = 0, w = 0;
  for (const [tf, k] of Object.entries(WEIGHT)) if (an[tf]) { s += an[tf].score * k; w += 3 * k; }
  return w ? s / w : 0;
}

/* ================= ФУТПРІНТ ================= */
export function addTrades(fp, trades, cfg) {
  fp.bars = fp.bars || {}; fp.big = fp.big || [];
  for (const t of trades) {
    const bt = Math.floor(t.t / BAR) * BAR, b = fp.bars[bt] || (fp.bars[bt] = { lv: {}, d: 0, v: 0, n: 0 });
    const px = (Math.floor(t.p / cfg.tick) * cfg.tick).toFixed(2), cell = b.lv[px] || (b.lv[px] = [0, 0]);
    cell[t.buy ? 1 : 0] += t.q; b.d += t.buy ? t.q : -t.q; b.v += t.q; b.n++;
    if (t.q >= cfg.bigLot) fp.big.push({ t: t.t, p: t.p, q: +t.q.toFixed(3), buy: t.buy });
  }
  const keep = Object.keys(fp.bars).map(Number).sort((a, b) => b - a).slice(0, 4);
  fp.bars = Object.fromEntries(keep.map(k => [k, fp.bars[k]]));
  for (const k of keep) for (const p in fp.bars[k].lv) fp.bars[k].lv[p] = fp.bars[k].lv[p].map(x => +x.toFixed(3));
  const since = (trades.length ? trades[trades.length - 1].t : Date.now()) - 4 * 36e5;
  fp.big = fp.big.filter(x => x.t >= since).slice(-60);
  return fp;
}
// Діагональні імбаланси: покупки на рівні i проти продажів на рівні нижче (і навпаки); «стек» — кілька поспіль
export function imbalances(bar, ratio, minQ = .5) {
  if (!bar) return { buyStack: 0, sellStack: 0, buyAt: null, sellAt: null };
  const lv = Object.entries(bar.lv).map(([p, [s, b]]) => ({ p: +p, s, b })).sort((a, b) => a.p - b.p);
  let run = 0, bestB = 0, atB = null, runS = 0, bestS = 0, atS = null;
  for (let i = 0; i < lv.length; i++) {
    const below = lv[i - 1], above = lv[i + 1];
    const bi = i > 0 && lv[i].b >= minQ && lv[i].b >= ratio * Math.max(below.s, .001);
    const si = i < lv.length - 1 && lv[i].s >= minQ && lv[i].s >= ratio * Math.max(above.b, .001);
    run = bi ? run + 1 : 0; if (run > bestB) { bestB = run; atB = lv[i].p; }
    runS = si ? runS + 1 : 0; if (runS > bestS) { bestS = runS; atS = lv[i].p; }
  }
  return { buyStack: bestB, sellStack: bestS, buyAt: atB, sellAt: atS };
}

/* ================= СИГНАЛ ================= */
export function keyLevels(an, day) {
  const L = [];
  for (const tf of ['1h', '30m', '15m']) {
    const a = an[tf]; if (!a) continue;
    const T = tf.toUpperCase();
    L.push({ p: a.poc, n: `POC ${T}` }, { p: a.vah, n: `VAH ${T}` }, { p: a.val, n: `VAL ${T}` });
    a.hvn.forEach(p => L.push({ p, n: `HVN ${T}` }));
  }
  if (day) L.push({ p: day.v, n: 'VWAP дня' }, { p: day.v + day.sd, n: 'VWAP +1σ' }, { p: day.v - day.sd, n: 'VWAP −1σ' });
  return L.filter(l => Number.isFinite(l.p)).sort((a, b) => a.p - b.p);
}
const f2 = x => (Number.isFinite(x) ? x.toFixed(2) : '—');
// Оцінка закритої 5M свічки: {dir, entry, sl, tp, why} або {dir:0, why}
export function findSetup({ bias, levels, bar, fpBar, big, c15, atr5, cfg, price }) {
  const dir = bias >= cfg.bias ? 1 : bias <= -cfg.bias ? -1 : 0;
  if (!dir) return { dir: 0, why: `ухил нейтральний (${bias.toFixed(2)}) — не торгуємо` };
  const tol = Math.max(cfg.tolAtr * atr5, .05);
  const touched = levels.filter(L => (dir > 0 ? bar.l <= L.p + tol && bar.c > L.p : bar.h >= L.p - tol && bar.c < L.p));
  if (!touched.length) return { dir: 0, why: `ухил ${dir > 0 ? 'лонг' : 'шорт'}, але немає реакції від рівня` };
  const lvl = dir > 0 ? touched[touched.length - 1] : touched[0];
  const d = fpBar ? fpBar.d : delta(bar);
  const imb = imbalances(fpBar, cfg.imbRatio);
  const inBar = big.filter(x => x.t >= bar.t && x.t < bar.t + BAR);
  const bigB = inBar.filter(x => x.buy).reduce((s, x) => s + x.q, 0), bigS = inBar.filter(x => !x.buy).reduce((s, x) => s + x.q, 0);
  const stack = dir > 0 ? imb.buyStack : imb.sellStack;
  const flowOk = stack >= cfg.stack || (dir > 0 ? bigB > bigS && bigB > 0 : bigS > bigB && bigS > 0);
  const c15d = c15.slice(-3).reduce((s, c) => s + delta(c), 0);
  const facts = `рівень ${lvl.n} ${f2(lvl.p)}, дельта ${d > 0 ? '+' : ''}${d.toFixed(1)}, стек ${stack}, великі ${bigB.toFixed(0)}/${bigS.toFixed(0)}, CVD 15M ${c15d > 0 ? '+' : ''}${c15d.toFixed(0)}`;
  if (sgn(d) !== dir) return { dir: 0, why: `реакція від рівня без підтвердження дельтою (${facts})` };
  if (!flowOk) return { dir: 0, why: `немає імбалансів/великих угод на боці входу (${facts})` };
  if (sgn(c15d) === -dir) return { dir: 0, why: `15M CVD проти входу (${facts})` };
  const entry = price, sl = dir > 0 ? Math.min(bar.l, lvl.p) - .2 * atr5 : Math.max(bar.h, lvl.p) + .2 * atr5;
  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return { dir: 0, why: 'ціна вже за стопом' };
  const target = levels.map(L => L.p).filter(p => dir * (p - entry) >= cfg.minRR * risk).sort((a, b) => dir * (a - b))[0];
  const tp = target !== undefined && dir * (target - entry) <= cfg.rr * risk * 2 ? target : entry + dir * cfg.rr * risk;
  return { dir, entry, sl, tp, why: `${dir > 0 ? 'ЛОНГ' : 'ШОРТ'}: ${facts}` };
}

/* ================= СТАН І ЗБЕРІГАННЯ ================= */
const ready = new WeakSet();
export async function ensureTraderSchema(db) {
  if (ready.has(db)) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS trader (k TEXT PRIMARY KEY, v TEXT NOT NULL)').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY AUTOINCREMENT, dir INTEGER NOT NULL, qty REAL NOT NULL, entry REAL NOT NULL, sl REAL NOT NULL, tp REAL NOT NULL, exit REAL NOT NULL, opened INTEGER NOT NULL, closed INTEGER NOT NULL, pnl REAL NOT NULL, r REAL NOT NULL, why TEXT NOT NULL, exitWhy TEXT NOT NULL)').run();
  ready.add(db);
}
function freshState(cfg = DEFAULT_CFG) {
  return { cfg: { ...cfg }, bal: cfg.start, pos: null, stats: { n: 0, wins: 0, gp: 0, gl: 0, peak: cfg.start, dd: 0, best: 0, worst: 0, sumR: 0 },
    eq: [], log: [], fp: {}, an: null, src: '', err: '', run: 0, lastId: 0, lastT: 0, lastBar5: 0, since: Date.now() };
}
export async function loadState(db) {
  await ensureTraderSchema(db);
  const r = await db.prepare('SELECT v FROM trader WHERE k = ?').bind('st').first();
  if (!r) return freshState();
  try { const s = JSON.parse(r.v); s.cfg = cleanCfg(s.cfg); return s; } catch { return freshState(); }
}
async function saveState(db, st) {
  await db.prepare('INSERT INTO trader (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind('st', JSON.stringify(st)).run();
}
const log = (st, t, text) => { st.log.unshift({ t, text: String(text).slice(0, 300) }); st.log = st.log.slice(0, 60); };

async function closePos(db, st, price, t, why) {
  const p = st.pos, fee = st.cfg.fee / 100 * (p.entry + price) * p.qty;
  const pnl = p.dir * (price - p.entry) * p.qty - fee, r = pnl / p.riskUsd;
  st.bal += pnl;
  const s = st.stats; s.n++; if (pnl > 0) { s.wins++; s.gp += pnl; } else s.gl += -pnl;
  s.best = Math.max(s.best, pnl); s.worst = Math.min(s.worst, pnl); s.sumR += r;
  s.peak = Math.max(s.peak, st.bal); s.dd = Math.max(s.dd, (s.peak - st.bal) / s.peak * 100);
  st.eq.push({ t, b: +st.bal.toFixed(2) }); st.eq = st.eq.slice(-300);
  await db.prepare('INSERT INTO trades (dir, qty, entry, sl, tp, exit, opened, closed, pnl, r, why, exitWhy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(p.dir, p.qty, p.entry, p.sl, p.tp, price, p.opened, t, +pnl.toFixed(2), +r.toFixed(2), p.why.slice(0, 300), why).run();
  log(st, t, `Закрито ${p.dir > 0 ? 'лонг' : 'шорт'} за ${f2(price)} (${why}): ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT, ${r.toFixed(2)}R`);
  st.pos = null;
}

/* ================= ОДИН ЦИКЛ (кожну хвилину з розкладу) ================= */
export async function runTrader(db, now = Date.now()) {
  const st = await loadState(db), cfg = st.cfg, prevRun = st.run;
  st.run = now;
  let C = {}, trades = [];
  try {
    const first = await fetchCandles('5m', st.src || 'binance');
    const src = first.src;
    const rest = await Promise.all(TFS.filter(tf => tf !== '5m').map(tf => fetchCandles(tf, src)));
    C['5m'] = first.c; TFS.filter(tf => tf !== '5m').forEach((tf, i) => { C[tf] = rest[i].c; });
    const stale = !prevRun || now - (st.lastT || 0) > 10 * 6e4;
    trades = await fetchTrades(src, stale || src !== st.src ? 0 : st.lastId, stale ? 0 : st.lastT);
    if (st.lastId && src === 'binance') trades = trades.filter(t => t.id > st.lastId);
    st.src = src; st.err = '';
  } catch (e) {
    st.err = `Немає даних з біржі: ${e && e.message}`;
    await saveState(db, st);
    return st;
  }
  if (trades.length) { st.lastId = trades[trades.length - 1].id || st.lastId; st.lastT = trades[trades.length - 1].t; }
  st.fp = addTrades(st.fp || {}, trades, cfg);

  // Аналіз зверху вниз
  const dayStart = Math.floor(now / 864e5) * 864e5, wd = (new Date(dayStart).getUTCDay() + 6) % 7, weekStart = dayStart - wd * 864e5;
  let day5 = C['5m'].filter(c => c.t >= dayStart); if (day5.length < 6) day5 = C['5m'].slice(-288);
  let week1 = C['1h'].filter(c => c.t >= weekStart); if (week1.length < 6) week1 = C['1h'].slice(-120);
  const vDay = vwap(day5), vWeek = vwap(week1), an = {};
  for (const tf of TFS) an[tf] = analyzeTF(tf, C[tf], ['4h', '2h'].includes(tf) ? vWeek : vDay);
  const bias = topDownBias(an), price = C['5m'][C['5m'].length - 1].c, atr5 = atr(C['5m'].slice(0, -1));
  const levels = keyLevels(an, vDay);

  // Супровід відкритої позиції: перший дотик стопу або цілі в стрічці угод (стоп перевіряється першим)
  if (st.pos) {
    const p = st.pos, path = trades.length ? trades : [{ p: price, t: now }];
    for (const t of path) {
      if (p.dir * (t.p - p.sl) <= 0) { await closePos(db, st, p.sl, t.t, 'стоп'); break; }
      if (p.dir * (t.p - p.tp) >= 0) { await closePos(db, st, p.tp, t.t, 'ціль'); break; }
    }
  }
  // Нова закрита 5M свічка → оцінка входу
  const closed = C['5m'][C['5m'].length - 2];
  if (closed && closed.t !== st.lastBar5) {
    st.lastBar5 = closed.t;
    if (st.pos && st.pos.dir * bias <= -cfg.bias) await closePos(db, st, price, now, 'ухил змінився');
    if (!st.pos && cfg.on) {
      const s = findSetup({ bias, levels, bar: closed, fpBar: st.fp.bars[closed.t], big: st.fp.big, c15: C['15m'].slice(0, -1), atr5, cfg, price });
      if (s.dir) {
        const riskUsd = st.bal * cfg.risk / 100;
        let qty = Math.floor(riskUsd / Math.abs(s.entry - s.sl) / .001) * .001;
        qty = Math.min(qty, Math.floor(st.bal * 5 / s.entry / .001) * .001);   // плече не більше 5×
        if (qty >= .001) {
          st.pos = { dir: s.dir, qty: +qty.toFixed(3), entry: s.entry, sl: +s.sl.toFixed(2), tp: +s.tp.toFixed(2), opened: now, riskUsd: Math.abs(s.entry - s.sl) * qty, why: s.why };
          log(st, now, `Вхід ${s.why}. Ціна ${f2(s.entry)}, стоп ${f2(s.sl)}, ціль ${f2(s.tp)}, обсяг ${qty.toFixed(3)} oz`);
        } else log(st, now, 'Сигнал є, але обсяг замалий для ризику');
      } else log(st, closed.t + BAR, `5M ${new Date(closed.t).toISOString().slice(11, 16)}: ${s.why}`);
    } else if (!cfg.on) log(st, closed.t + BAR, `5M ${new Date(closed.t).toISOString().slice(11, 16)}: трейдер на паузі`);
  }

  const lastFp = st.fp.bars[closed ? closed.t : 0], imb = imbalances(lastFp, cfg.imbRatio);
  st.an = {
    t: now, price, bias: +bias.toFixed(3), atr5: +atr5.toFixed(2), vDay: vDay && +vDay.v.toFixed(2), vWeek: vWeek && +vWeek.v.toFixed(2), est: Boolean(C['5m'][0].est),
    tfs: TFS.map(tf => { const a = an[tf]; return { tf, bias: a.bias, score: a.score, vwap: +a.vwap.toFixed(2), poc: +a.poc.toFixed(2), vah: +a.vah.toFixed(2), val: +a.val.toFixed(2), cvd: +a.cvd.toFixed(1), div: a.div, hvn: a.hvn.slice(0, 4).map(x => +x.toFixed(2)), lvn: a.lvn.slice(0, 4).map(x => +x.toFixed(2)) }; }),
    levels: levels.map(l => ({ p: +l.p.toFixed(2), n: l.n })),
    flow: lastFp ? { d: +lastFp.d.toFixed(1), v: +lastFp.v.toFixed(1), n: lastFp.n, ...imb } : null
  };
  if (!st.eq.length || now - st.eq[st.eq.length - 1].t > 36e5) { st.eq.push({ t: now, b: +st.bal.toFixed(2) }); st.eq = st.eq.slice(-300); }
  await saveState(db, st);
  return st;
}

/* ================= ДЛЯ САЙТУ І ВЛАСТЕЛІНА ================= */
export async function traderView(db) {
  const st = await loadState(db);
  const { results } = await db.prepare('SELECT * FROM trades ORDER BY id DESC LIMIT 50').all();
  const s = st.stats;
  const open = st.pos && st.an ? { ...st.pos, upnl: +(st.pos.dir * (st.an.price - st.pos.entry) * st.pos.qty).toFixed(2) } : st.pos;
  return {
    cfg: st.cfg, bal: +st.bal.toFixed(2), pos: open, src: st.src, err: st.err, run: st.run, since: st.since, an: st.an,
    stats: { n: s.n, wins: s.wins, winRate: s.n ? +(s.wins / s.n * 100).toFixed(1) : 0, pnl: +(st.bal - st.cfg.start).toFixed(2), pnlPct: +((st.bal / st.cfg.start - 1) * 100).toFixed(2),
      pf: s.gl ? +(s.gp / s.gl).toFixed(2) : (s.gp ? null : 0), dd: +s.dd.toFixed(2), best: +s.best.toFixed(2), worst: +s.worst.toFixed(2), avgR: s.n ? +(s.sumR / s.n).toFixed(2) : 0 },
    eq: st.eq, log: st.log.slice(0, 30), trades: results || [],
    big: (st.fp.big || []).slice(-15).reverse()
  };
}
export async function traderControl(db, b = {}) {
  const st = await loadState(db);
  if (b.action === 'start' || b.action === 'stop') { st.cfg.on = b.action === 'start'; log(st, Date.now(), st.cfg.on ? 'Трейдера запущено' : 'Трейдера поставлено на паузу'); }
  else if (b.action === 'config') { const on = st.cfg.on; st.cfg = cleanCfg({ ...b.cfg, on }, st.cfg); log(st, Date.now(), 'Налаштування змінено'); }
  else if (b.action === 'reset') {
    const cfg = st.cfg, fresh = freshState({ ...cfg });
    await db.prepare('DELETE FROM trades').run();
    fresh.bal = cfg.start; fresh.stats.peak = cfg.start;
    Object.assign(st, fresh); log(st, Date.now(), `Рахунок скинуто: ${cfg.start} USDT`);
  } else if (b.action === 'close') {
    if (!st.pos || !st.an) return { error: 'Немає відкритої позиції' };
    await closePos(db, st, st.an.price, Date.now(), 'закрито вручну');
  } else return { error: 'Невідома дія' };
  await saveState(db, st);
  return { ok: true };
}
// Коротке зведення для Властеліна (інструмент trader_report)
export async function traderReport(db) {
  const v = await traderView(db), s = v.stats, a = v.an;
  if (!a) return 'Трейдер XAU ще не запускався (дані з’являться протягом хвилини).';
  const lines = [
    `Трейдер XAU (паперова торгівля, ${v.cfg.on ? 'працює' : 'на паузі'}), джерело ${v.src || '—'}${v.err ? ', помилка: ' + v.err : ''}.`,
    `Баланс ${v.bal} USDT (старт ${v.cfg.start}), P/L ${s.pnl} (${s.pnlPct}%), угод ${s.n}, виграшних ${s.winRate}%, profit factor ${s.pf ?? '∞'}, макс. просідання ${s.dd}%, середнє ${s.avgR}R.`,
    `Ціна ${a.price}, загальний ухил ${a.bias} (від −1 до +1), VWAP дня ${a.vDay}, тижня ${a.vWeek}.`,
    'ТФ: ' + a.tfs.map(t => `${t.tf} ${t.bias} (POC ${t.poc}, CVD ${t.cvd}${t.div ? ', дивергенція ' + t.div : ''})`).join('; '),
    v.pos ? `Відкрита позиція: ${v.pos.dir > 0 ? 'лонг' : 'шорт'} ${v.pos.qty} oz від ${v.pos.entry}, стоп ${v.pos.sl}, ціль ${v.pos.tp}, P/L ${v.pos.upnl}.` : 'Позиції немає.',
    'Останні події: ' + v.log.slice(0, 5).map(l => l.text).join(' | '),
    'Останні угоди: ' + v.trades.slice(0, 5).map(t => `${t.dir > 0 ? 'L' : 'S'} ${t.entry}→${t.exit} ${t.pnl} (${t.exitWhy})`).join('; ')
  ];
  return lines.join('\n');
}
