// Трейдер XAU — паперова торгівля XAU/USDT за потоком ордерів.
// Аналіз зверху вниз 4H → 2H → 1H → 30M → 15M → 5M; вхід на закритті 5M.
// Сетапи: відкат по тренду від рівня, розворот від зони опору/підтримки, розворот від мід-поінта.
// Ціль 3R за замовчуванням; 2R — коли на шляху опір, близько новини або так підказує власна статистика (навчання на MFE).
// Інструменти: VWAP, Volume Profile (POC/VAH/VAL, HVN/LVN), CVD, футпрінт (імбаланси), великі угоди, фундамент і календар.
// Рішення приймає детермінований код (без ШІ на кожній хвилині): дешево, швидко, перевірювано. Реальних ордерів немає.

export const TFS = ['4h', '2h', '1h', '30m', '15m', '5m'];
const LIMIT = { '4h': 120, '2h': 120, '1h': 200, '30m': 120, '15m': 120, '5m': 300 };
const LOOK = { '4h': 60, '2h': 60, '1h': 72, '30m': 96, '15m': 96, '5m': 144 };   // свічок для профілю обсягу
const WEIGHT = { '4h': 3, '2h': 2, '1h': 2, '30m': 1 };                           // вага старших ТФ в ухилі
const LVL_W = { '4h': 3, '2h': 2.5, '1h': 2, '30m': 1.5, '15m': 1 };             // «сила» рівня за ТФ
const BAR = 3e5;   // 5 хв
export const SETUPS = { pull: 'Відкат по тренду', zone: 'Розворот від зони', mid: 'Розворот від мід-поінта' };

export const DEFAULT_CFG = { on: true, start: 10000, risk: 1, rr: 3, rr2: 2, minRR: 2, bigLot: 20, imbRatio: 3, stack: 3, tick: 0.5, fee: 0.04, bias: 0.3, tolAtr: 0.3,
  zoneMin: 2, newsLock: 30, learnMin: 8, sPull: true, sZone: true, sMid: true, fundFilter: true };
const CFG_LIMITS = { start: [100, 1e7], risk: [0.1, 5], rr: [1, 6], rr2: [1, 6], minRR: [1, 5], bigLot: [0.1, 1000], imbRatio: [1.5, 10], stack: [1, 8], tick: [0.1, 5], fee: [0, 0.3],
  bias: [0.05, 0.9], tolAtr: [0.05, 1.5], zoneMin: [2, 6], newsLock: [0, 240], learnMin: [3, 100] };
const BOOLS = ['on', 'sPull', 'sZone', 'sMid', 'fundFilter'];
export function cleanCfg(input = {}, base = DEFAULT_CFG) {
  const c = { ...DEFAULT_CFG, ...base };
  for (const [k, [lo, hi]] of Object.entries(CFG_LIMITS)) {
    if (input[k] === undefined || input[k] === '' || input[k] === null) continue;
    const v = Number(input[k]);
    if (Number.isFinite(v)) c[k] = Math.min(hi, Math.max(lo, v));
  }
  for (const k of BOOLS) if (k in input) c[k] = Boolean(input[k]);
  c.stack = Math.round(c.stack); c.zoneMin = Math.round(c.zoneMin); c.learnMin = Math.round(c.learnMin);
  if (c.rr2 > c.rr) c.rr2 = c.rr;
  if (c.minRR > c.rr2) c.minRR = c.rr2;
  return c;
}

/* ================= ДАНІ З БІРЖІ ================= */
async function getJ(u) {
  const r = await fetch(u, { headers: { 'User-Agent': 'vlastelin-trader' } });
  if (!r.ok) throw new Error(`${new URL(u).hostname} ${r.status}`);
  return r.json();
}
// Джерела даних. Binance і Bybit часто блокують запити з хмари Cloudflare (обмеження за країною),
// тому є ланцюжок запасних бірж із XAU/USDT: OKX → Gate → Bitget. Трейдер бере перше, що відповідає.
// Розмір угод і обсяг — завжди в унціях (oz). Окрім Binance, свічки не мають обсягу покупців → дельта ТФ наближена (est).
const est = (t, o, h, l, c, v) => ({ t, o, h, l, c, v, bv: v * (.5 + .5 * (c - o) / ((h - l) || 1)), est: true });
const asc = list => list.filter(c => [c.t, c.o, c.h, c.l, c.c, c.v].every(Number.isFinite)).sort((a, b) => a.t - b.t);
// 2H зі свічок 1H (для бірж без 2H)
function to2h(c1) {
  const out = [];
  for (const c of c1) {
    const t = Math.floor(c.t / 72e5) * 72e5, last = out[out.length - 1];
    if (last && last.t === t) { last.h = Math.max(last.h, c.h); last.l = Math.min(last.l, c.l); last.c = c.c; last.v += c.v; last.bv += c.bv; }
    else out.push({ ...c, t });
  }
  return out;
}
export const SOURCES = {
  binance: {
    name: 'Binance Futures',
    candles: async tf => (await getJ(`https://fapi.binance.com/fapi/v1/klines?symbol=XAUUSDT&interval=${tf}&limit=${LIMIT[tf]}`))
      .map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], bv: +r[9] })),
    async trades(st, fresh) {
      const out = []; let from = !fresh && st.lastId ? st.lastId + 1 : null;
      for (let page = 0; page < 3; page++) {
        const a = await getJ('https://fapi.binance.com/fapi/v1/aggTrades?symbol=XAUUSDT&limit=1000' + (from ? `&fromId=${from}` : ''));
        for (const x of a) out.push({ id: x.a, p: +x.p, q: +x.q, buy: !x.m, t: x.T });
        if (a.length < 1000 || !from) break;
        from = a[a.length - 1].a + 1;
      }
      return out;
    }
  },
  bybit: {
    name: 'Bybit',
    candles: async tf => asc((await getJ(`https://api.bybit.com/v5/market/kline?category=linear&symbol=XAUUSDT&interval=${{ '4h': 240, '2h': 120, '1h': 60, '30m': 30, '15m': 15, '5m': 5 }[tf]}&limit=${LIMIT[tf]}`))
      .result.list.map(r => est(+r[0], +r[1], +r[2], +r[3], +r[4], +r[5]))),
    trades: async () => (await getJ('https://api.bybit.com/v5/market/recent-trade?category=linear&symbol=XAUUSDT&limit=1000'))
      .result.list.map(x => ({ id: 0, p: +x.price, q: +x.size, buy: x.side === 'Buy', t: +x.time }))
  },
  okx: {
    name: 'OKX',
    // volCcy (r[6]) — обсяг в унціях; угоди — у контрактах по 0.001 oz
    candles: async tf => asc((await getJ(`https://www.okx.com/api/v5/market/candles?instId=XAU-USDT-SWAP&bar=${{ '4h': '4H', '2h': '2H', '1h': '1H', '30m': '30m', '15m': '15m', '5m': '5m' }[tf]}&limit=${Math.min(300, LIMIT[tf])}`))
      .data.map(r => est(+r[0], +r[1], +r[2], +r[3], +r[4], +r[6]))),
    trades: async () => (await getJ('https://www.okx.com/api/v5/market/trades?instId=XAU-USDT-SWAP&limit=500'))
      .data.map(x => ({ id: 0, p: +x.px, q: +x.sz * .001, buy: x.side === 'buy', t: +x.ts }))
  },
  gate: {
    name: 'Gate',
    no2h: true,
    // контракт = 0.0001 oz; розмір угоди зі знаком: + купівля, − продаж
    candles: async tf => asc((await getJ(`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=XAU_USDT&interval=${tf}&limit=${LIMIT[tf]}`))
      .map(r => est(r.t * 1000, +r.o, +r.h, +r.l, +r.c, r.v * 1e-4))),
    trades: async () => (await getJ('https://api.gateio.ws/api/v4/futures/usdt/trades?contract=XAU_USDT&limit=1000'))
      .map(x => ({ id: 0, p: +x.price, q: Math.abs(x.size) * 1e-4, buy: x.size > 0, t: Math.round(x.create_time_ms * 1000) }))
  },
  bitget: {
    name: 'Bitget',
    no2h: true,
    candles: async tf => asc((await getJ(`https://api.bitget.com/api/v2/mix/market/candles?symbol=XAUUSDT&productType=USDT-FUTURES&granularity=${{ '4h': '4H', '1h': '1H', '30m': '30m', '15m': '15m', '5m': '5m' }[tf]}&limit=${LIMIT[tf]}`))
      .data.map(r => est(+r[0], +r[1], +r[2], +r[3], +r[4], +r[5]))),
    trades: async () => (await getJ('https://api.bitget.com/api/v2/mix/market/fills?symbol=XAUUSDT&productType=USDT-FUTURES&limit=100'))
      .data.map(x => ({ id: 0, p: +x.price, q: +x.size, buy: x.side === 'buy', t: +x.ts }))
  }
};
export const SOURCE_ORDER = ['binance', 'bybit', 'okx', 'gate', 'bitget'];
// Свічки всіх ТФ + нові угоди з першого робочого джерела (починаємо з того, що працювало минулого разу)
export async function fetchMarket(st, fresh) {
  const order = [st.src, ...SOURCE_ORDER.filter(s => s !== st.src)].filter(s => SOURCES[s]), errs = {};
  for (const s of order) {
    const S = SOURCES[s];
    try {
      const tfs = S.no2h ? TFS.filter(tf => tf !== '2h') : TFS;
      const got = await Promise.all(tfs.map(tf => S.candles(tf))), C = {};
      tfs.forEach((tf, i) => { C[tf] = got[i]; });
      if (S.no2h) C['2h'] = to2h(C['1h']);
      if (TFS.some(tf => !C[tf] || C[tf].length < 20)) throw new Error('замало свічок');
      let trades = [];
      try {
        trades = (await S.trades(st, fresh || s !== st.src)).filter(t => Number.isFinite(t.p) && t.q > 0).sort((a, b) => a.t - b.t);
        if (s === 'binance') { if (st.lastId && !fresh && s === st.src) trades = trades.filter(t => t.id > st.lastId); }
        else if (st.lastT && !fresh && s === st.src) trades = trades.filter(t => t.t > st.lastT);
      } catch (e) { errs[s + ' угоди'] = String(e && e.message).slice(0, 60); }
      return { src: s, C, trades, errs };
    } catch (e) { errs[s] = String(e && e.message).slice(0, 60); }
  }
  throw new Error(Object.entries(errs).map(([k, v]) => `${k}: ${v}`).join('; '));
}
// Спотова ціна золота XAUUSD (близька до FOREX.com на TradingView) — для перерахунку рівнів на графік власника
export async function fetchSpot() {
  const j = await getJ('https://api.gold-api.com/price/XAU');
  const p = Number(j.price);
  if (!Number.isFinite(p)) throw new Error('немає ціни');
  return { p, t: Date.parse(j.updatedAt) || Date.now() };
}
// Економічний календар (ForexFactory, без ключа): важливі новини США на 48 год уперед
export async function fetchCalendar(now = Date.now()) {
  const list = await getJ('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
  return list.filter(e => e.country === 'USD' && (e.impact === 'High' || e.impact === 'Medium'))
    .map(e => ({ t: Date.parse(e.date), title: String(e.title).slice(0, 80), impact: e.impact === 'High' ? 'high' : 'med', f: e.forecast || '', p: e.previous || '' }))
    .filter(e => Number.isFinite(e.t) && e.t > now - 36e5 && e.t < now + 48 * 36e5).sort((a, b) => a.t - b.t).slice(0, 20);
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

/* ================= РІВНІ, ЗОНИ, МІД-ПОІНТИ ================= */
// {p, n, w (сила), kind: poc|vah|val|hvn|vwap|mid|swing}
export function keyLevels(an, day, extra = {}) {
  const L = [];
  for (const tf of ['4h', '2h', '1h', '30m', '15m']) {
    const a = an[tf]; if (!a) continue;
    const T = tf.toUpperCase(), w = LVL_W[tf];
    L.push({ p: a.poc, n: `POC ${T}`, w, kind: 'poc' }, { p: a.vah, n: `VAH ${T}`, w, kind: 'vah' }, { p: a.val, n: `VAL ${T}`, w, kind: 'val' });
    if (['1h', '30m'].includes(tf)) L.push({ p: (a.vah + a.val) / 2, n: `MID VA ${T}`, w, kind: 'mid' });
    if (['1h', '30m', '15m'].includes(tf)) a.hvn.forEach(p => L.push({ p, n: `HVN ${T}`, w: w * .8, kind: 'hvn' }));
  }
  if (day) L.push({ p: day.v, n: 'VWAP дня', w: 2.5, kind: 'vwap' }, { p: day.v + day.sd, n: 'VWAP +1σ', w: 1.5, kind: 'vwap' }, { p: day.v - day.sd, n: 'VWAP −1σ', w: 1.5, kind: 'vwap' });
  if (extra.prevDay) L.push({ p: extra.prevDay.mid, n: 'MID вчора', w: 2.5, kind: 'mid' }, { p: extra.prevDay.h, n: 'High вчора', w: 2.5, kind: 'swing' }, { p: extra.prevDay.l, n: 'Low вчора', w: 2.5, kind: 'swing' });
  if (extra.swing) L.push({ p: extra.swing.mid, n: 'MID свінгу 12г', w: 2, kind: 'mid' }, { p: extra.swing.h, n: 'Swing High 12г', w: 2, kind: 'swing' }, { p: extra.swing.l, n: 'Swing Low 12г', w: 2, kind: 'swing' });
  return L.filter(l => Number.isFinite(l.p)).sort((a, b) => a.p - b.p);
}
// Зони: рівні, що стоять близько один до одного (конфлюенс). Сила = кількість і вага рівнів
export function buildZones(levels, width) {
  const zones = []; let cur = null;
  for (const l of levels.filter(x => x.kind !== 'mid')) {
    if (cur && l.p - cur.hi <= width && l.p - cur.lo <= 2.5 * width) { cur.hi = l.p; cur.items.push(l); }
    else { cur = { lo: l.p, hi: l.p, items: [l] }; zones.push(cur); }
  }
  return zones.filter(z => z.items.length >= 2).map(z => ({ lo: z.lo, hi: z.hi, count: z.items.length, w: z.items.reduce((s, x) => s + x.w, 0), names: z.items.map(x => x.n) }));
}

/* ================= СИГНАЛ І ПОЯСНЕННЯ ================= */
const f2 = x => (Number.isFinite(x) ? x.toFixed(2) : '—');
const pm = (x, d = 1) => (x > 0 ? '+' : '') + (+x).toFixed(d);
const hhmm = t => new Date(t).toISOString().slice(11, 16) + ' UTC';
const ARROW = { long: '▲', short: '▼', flat: '◆' };
function fundLabel(b) { return b >= .3 ? 'бичачий для золота' : b <= -.3 ? 'ведмежий для золота' : 'нейтральний'; }

// Вибір цілі: 3R за замовчуванням, 2R — коли так розумніше. Повертає {tp, rMul, why, obstacle} або {skip}
export function chooseTarget({ dir, entry, sl, levels, zones, cfg, learn, news, from }) {
  const R = Math.abs(entry - sl), d = x => dir * (x - entry) / R;   // відстань у R
  const obst = [
    ...levels.filter(l => l.w >= 2 && l.kind !== 'mid').map(l => ({ at: d(l.p), n: `${l.n} ${f2(l.p)}` })),
    ...zones.filter(z => z.count >= cfg.zoneMin).map(z => ({ at: d(dir > 0 ? z.lo : z.hi), n: `зона ${f2(z.lo)}–${f2(z.hi)} (${z.names.join(' + ')})` }))
  ].filter(o => o.at > .3 && o.at < cfg.rr && !(from && o.n.includes(from))).sort((a, b) => a.at - b.at);
  const first = obst[0];
  if (first && first.at < cfg.minRR) return { skip: `сильний ${dir > 0 ? 'опір' : 'підтримка'} ${first.n} уже на ${first.at.toFixed(1)}R — до ${cfg.minRR}R не дійти` };
  const tp = r => entry + dir * r * R;
  if (first && first.at < cfg.rr) return { tp: tp(cfg.rr2), rMul: cfg.rr2, obstacle: first.n, why: `на шляху до ${cfg.rr}R ${dir > 0 ? 'опір' : 'підтримка'} ${first.n} (${first.at.toFixed(1)}R) — беремо ${cfg.rr2}R` };
  if (news) return { tp: tp(cfg.rr2), rMul: cfg.rr2, why: `о ${hhmm(news.t)} новини «${news.title}» — беремо швидшу ціль ${cfg.rr2}R` };
  if (learn && learn.n >= cfg.learnMin) {
    const e3 = cfg.rr * learn.p3 - (1 - learn.p3), e2 = cfg.rr2 * learn.p2 - (1 - learn.p2);
    if (e2 > e3) return { tp: tp(cfg.rr2), rMul: cfg.rr2, why: `навчання: у цьому сетапі ${cfg.rr}R досягали ${Math.round(learn.p3 * 100)}%, ${cfg.rr2}R — ${Math.round(learn.p2 * 100)}% з ${learn.n} угод (очікування ${pm(e2, 2)}R проти ${pm(e3, 2)}R) — беремо ${cfg.rr2}R` };
    return { tp: tp(cfg.rr), rMul: cfg.rr, why: `шлях до ${cfg.rr}R вільний; статистика сетапу за ${cfg.rr}R (${pm(e3, 2)}R проти ${pm(e2, 2)}R)` };
  }
  return { tp: tp(cfg.rr), rMul: cfg.rr, why: `шлях до ${cfg.rr}R вільний від сильних рівнів` };
}

// Оцінка закритої 5M свічки: {dir, setup, entry, sl, tp, rMul, why, factors, tgtWhy} або {dir:0, why}
export function findSetup({ bias, an = {}, levels, zones = [], bar, fpBar, big, c15, atr5, cfg, price, fund = null, cal = [], learn = {}, now = Date.now(), basis = null }) {
  const lock = cal.find(e => e.impact === 'high' && e.t > now - 15 * 6e4 && e.t < now + cfg.newsLock * 6e4);
  if (lock) return { dir: 0, why: `пауза у входах: новини США «${lock.title}» о ${hhmm(lock.t)}` };
  const tol = Math.max(cfg.tolAtr * atr5, .05), rng = (bar.h - bar.l) || 1e-9;
  const upW = (bar.h - Math.max(bar.o, bar.c)) / rng, dnW = (Math.min(bar.o, bar.c) - bar.l) / rng;
  const cands = [];
  if (cfg.sZone) for (const z of zones) {
    if (z.count < cfg.zoneMin) continue;
    const nm = `${z.names.join(' + ')}`;
    if (bar.h >= z.lo - tol && bar.c < z.lo && upW >= .35 && bias < .6)
      cands.push({ dir: -1, setup: 'zone', q: 3 + z.w, ref: z.hi, from: z.names[0], txt: `розворот від зони опору ${f2(z.lo)}–${f2(z.hi)} (${nm}; сила ${z.count})`, wick: upW });
    if (bar.l <= z.hi + tol && bar.c > z.hi && dnW >= .35 && bias > -.6)
      cands.push({ dir: 1, setup: 'zone', q: 3 + z.w, ref: z.lo, from: z.names[0], txt: `розворот від зони підтримки ${f2(z.lo)}–${f2(z.hi)} (${nm}; сила ${z.count})`, wick: dnW });
  }
  if (cfg.sMid) for (const L of levels.filter(l => l.kind === 'mid')) {
    if (bar.h >= L.p - tol && bar.c < L.p && upW >= .3 && bias <= cfg.bias) cands.push({ dir: -1, setup: 'mid', q: 2 + L.w, ref: L.p, from: L.n, txt: `розворот від мід-поінта ${L.n} ${f2(L.p)}`, wick: upW });
    if (bar.l <= L.p + tol && bar.c > L.p && dnW >= .3 && bias >= -cfg.bias) cands.push({ dir: 1, setup: 'mid', q: 2 + L.w, ref: L.p, from: L.n, txt: `розворот від мід-поінта ${L.n} ${f2(L.p)}`, wick: dnW });
  }
  if (cfg.sPull) {
    const dir = bias >= cfg.bias ? 1 : bias <= -cfg.bias ? -1 : 0;
    const touched = dir ? levels.filter(L => L.kind !== 'mid' && (dir > 0 ? bar.l <= L.p + tol && bar.c > L.p : bar.h >= L.p - tol && bar.c < L.p)) : [];
    if (touched.length) {
      const L = touched.reduce((a, b) => (b.w > a.w ? b : a));
      cands.push({ dir, setup: 'pull', q: 1 + L.w, ref: L.p, from: L.n, txt: `відкат по тренду до ${L.n} ${f2(L.p)}`, wick: dir > 0 ? dnW : upW });
    }
  }
  if (!cands.length) {
    const b = bias >= cfg.bias ? 'лонг' : bias <= -cfg.bias ? 'шорт' : 'нейтральний';
    return { dir: 0, why: `ухил ${b} (${bias.toFixed(2)}), реакції від рівня, зони чи мід-поінта немає` };
  }
  cands.sort((a, b) => b.q - a.q);
  const d = fpBar ? fpBar.d : delta(bar), imb = imbalances(fpBar, cfg.imbRatio);
  const inBar = big.filter(x => x.t >= bar.t && x.t < bar.t + BAR);
  const bigB = inBar.filter(x => x.buy).reduce((s, x) => s + x.q, 0), bigS = inBar.filter(x => !x.buy).reduce((s, x) => s + x.q, 0);
  const c15d = c15.slice(-3).reduce((s, c) => s + delta(c), 0);
  const news = cal.find(e => e.impact === 'high' && e.t > now && e.t < now + 2 * 36e5);
  let firstFail = '';
  for (const c of cands) {
    const dir = c.dir, stack = dir > 0 ? imb.buyStack : imb.sellStack, at = dir > 0 ? imb.buyAt : imb.sellAt;
    const flowOk = stack >= cfg.stack || (dir > 0 ? bigB > bigS && bigB > 0 : bigS > bigB && bigS > 0);
    const facts = `дельта ${pm(d)}, стек ${stack}, великі ${bigB.toFixed(0)}/${bigS.toFixed(0)}`;
    const fail = sgn(d) !== dir ? `реакція без підтвердження дельтою (${facts})`
      : !flowOk ? `немає імбалансів/великих угод на боці входу (${facts})`
      : c.setup === 'pull' && sgn(c15d) === -dir ? `15M CVD ${pm(c15d, 0)} проти входу`
      : cfg.fundFilter && fund && dir * fund.bias <= -.5 ? `фундамент проти (${fundLabel(fund.bias)}, ${pm(fund.bias, 2)})` : '';
    if (fail) { firstFail = firstFail || `${SETUPS[c.setup]}: ${c.txt} — ${fail}`; continue; }
    const entry = price, sl = dir > 0 ? Math.min(bar.l, c.ref) - .2 * atr5 : Math.max(bar.h, c.ref) + .2 * atr5;
    if (!(Math.abs(entry - sl) > 0) || dir * (entry - sl) <= 0) { firstFail = firstFail || 'ціна вже за стопом'; continue; }
    const tg = chooseTarget({ dir, entry, sl, levels, zones, cfg, learn: learn[c.setup], news, from: c.from });
    if (tg.skip) { firstFail = firstFail || `${SETUPS[c.setup]}: ${tg.skip}`; continue; }
    const side = dir > 0 ? 'ЛОНГ' : 'ШОРТ';
    const tfLine = ['4h', '2h', '1h', '30m', '15m', '5m'].filter(tf => an[tf]).map(tf => `${tf.toUpperCase()} ${ARROW[an[tf].bias]}`).join(', ');
    const divs = ['4h', '1h', '30m', '15m'].filter(tf => an[tf] && an[tf].div).map(tf => `${an[tf].div === 'bull' ? 'бичача' : 'ведмежа'} дивергенція CVD ${tf.toUpperCase()}`);
    const factors = [
      `Чому ${side}: ${c.txt}.`,
      `Старші ТФ: ${tfLine} → загальний ухил ${pm(bias, 2)} (${bias >= cfg.bias ? 'вгору' : bias <= -cfg.bias ? 'вниз' : 'нейтрально'})${c.setup !== 'pull' && dir * bias < 0 ? ' — вхід проти ухилу, тому лише від сильної зони/мід-поінта' : ''}.`,
      `Свічка 5M: ${dir > 0 ? 'нижня' : 'верхня'} тінь ${Math.round(c.wick * 100)}% — ${dir > 0 ? 'продавців відкинули' : 'покупців відкинули'}, закриття ${dir > 0 ? 'вище' : 'нижче'} рівня.`,
      `Потік ордерів: дельта ${pm(d)} oz, стек ${dir > 0 ? 'покупних' : 'продажних'} імбалансів ${stack}${at ? ` (до ${f2(at)})` : ''}, великі угоди: купівля ${bigB.toFixed(0)} / продаж ${bigS.toFixed(0)} oz.`,
      `CVD 15M: ${pm(c15d, 0)}${divs.length ? '; ' + divs.join(', ') : ''}.`,
      `${dir > 0 ? 'Опір' : 'Підтримка'} на шляху: ${tg.obstacle || 'сильних рівнів до цілі немає'}.`,
      fund ? `Фундамент: ${fundLabel(fund.bias)} (${pm(fund.bias, 2)}) — ${fund.summary}` : 'Фундамент: свіжого огляду ще немає.',
      news ? `Новини: «${news.title}» о ${hhmm(news.t)}.` : 'Новини: важливих новин США найближчі 2 год немає.',
      `Ціль ${tg.rMul}R: ${tg.why}.`
    ];
    if (Number.isFinite(basis)) factors.push(`На графіку FOREX.com (спот XAUUSD, різниця ${pm(basis, 2)}): вхід ≈ ${f2(entry + basis)}, стоп ≈ ${f2(sl + basis)}, ціль ≈ ${f2(tg.tp + basis)}.`);
    return { dir, setup: c.setup, entry, sl, tp: tg.tp, rMul: tg.rMul, tgtWhy: tg.why, why: `${side} · ${SETUPS[c.setup]} · ${c.txt}`, factors };
  }
  return { dir: 0, why: firstFail };
}

/* ================= СТАН І ЗБЕРІГАННЯ ================= */
const ready = new WeakSet();
const TRADE_COLS = { setup: "TEXT NOT NULL DEFAULT ''", factors: "TEXT NOT NULL DEFAULT '[]'", rmul: 'REAL NOT NULL DEFAULT 0', mfe: 'REAL', tgtWhy: "TEXT NOT NULL DEFAULT ''" };
export async function ensureTraderSchema(db) {
  if (ready.has(db)) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS trader (k TEXT PRIMARY KEY, v TEXT NOT NULL)').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY AUTOINCREMENT, dir INTEGER NOT NULL, qty REAL NOT NULL, entry REAL NOT NULL, sl REAL NOT NULL, tp REAL NOT NULL, exit REAL NOT NULL, opened INTEGER NOT NULL, closed INTEGER NOT NULL, pnl REAL NOT NULL, r REAL NOT NULL, why TEXT NOT NULL, exitWhy TEXT NOT NULL)').run();
  const { results } = await db.prepare('PRAGMA table_info(trades)').all();
  const have = new Set((results || []).map(r => r.name));
  for (const [c, def] of Object.entries(TRADE_COLS)) if (!have.has(c)) await db.prepare(`ALTER TABLE trades ADD COLUMN ${c} ${def}`).run();
  ready.add(db);
}
function freshState(cfg = DEFAULT_CFG) {
  return { cfgV: 2, cfg: { ...cfg }, bal: cfg.start, pos: null, stats: { n: 0, wins: 0, gp: 0, gl: 0, peak: cfg.start, dd: 0, best: 0, worst: 0, sumR: 0 },
    eq: [], log: [], fp: {}, an: null, src: '', err: '', run: 0, lastId: 0, lastT: 0, lastBar5: 0, since: Date.now(), shadow: [], cal: [], calAt: 0, lessons: [] };
}
export async function loadState(db) {
  await ensureTraderSchema(db);
  const r = await db.prepare('SELECT v FROM trader WHERE k = ?').bind('st').first();
  if (!r) return freshState();
  try {
    const s = JSON.parse(r.v);
    if (s.cfgV !== 2) { s.cfg = { ...s.cfg, rr: 3, rr2: 2, minRR: 2 }; s.cfgV = 2; }   // власник: базова ціль 3R
    s.cfg = cleanCfg(s.cfg); s.shadow = s.shadow || []; s.cal = s.cal || []; s.lessons = s.lessons || [];
    return s;
  } catch { return freshState(); }
}
async function saveState(db, st) {
  await db.prepare('INSERT INTO trader (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind('st', JSON.stringify(st)).run();
}
export async function loadFund(db) {
  await ensureTraderSchema(db);
  const r = await db.prepare('SELECT v FROM trader WHERE k = ?').bind('fund').first();
  try { return r ? JSON.parse(r.v) : null; } catch { return null; }
}
export async function saveFund(db, f) {
  await ensureTraderSchema(db);
  await db.prepare('INSERT INTO trader (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind('fund', JSON.stringify(f)).run();
}
const log = (st, t, text) => { st.log.unshift({ t, text: String(text).slice(0, 400) }); st.log = st.log.slice(0, 80); };

// Навчання: як далеко (у R) заходили угоди кожного сетапу (MFE до 3R або до стопу)
export async function learnStats(db, cfg = DEFAULT_CFG) {
  const { results } = await db.prepare('SELECT setup, mfe, r FROM trades WHERE mfe IS NOT NULL').all();
  const out = {};
  for (const k of Object.keys(SETUPS)) {
    const rows = (results || []).filter(x => x.setup === k), n = rows.length;
    out[k] = { n, p2: n ? rows.filter(x => x.mfe >= cfg.rr2).length / n : 0, p3: n ? rows.filter(x => x.mfe >= cfg.rr).length / n : 0 };
  }
  return out;
}
async function setupStats(db) {
  const { results } = await db.prepare('SELECT setup, COUNT(*) AS n, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins, AVG(r) AS avgR, SUM(pnl) AS pnl FROM trades GROUP BY setup').all();
  return Object.fromEntries((results || []).map(x => [x.setup || 'pull', { n: x.n, wins: x.wins, avgR: +(+x.avgR || 0).toFixed(2), pnl: +(+x.pnl || 0).toFixed(2) }]));
}

async function closePos(db, st, price, t, why) {
  const p = st.pos, fee = st.cfg.fee / 100 * (p.entry + price) * p.qty;
  const pnl = p.dir * (price - p.entry) * p.qty - fee, r = pnl / p.riskUsd, R = Math.abs(p.entry - p.sl);
  st.bal += pnl;
  const s = st.stats; s.n++; if (pnl > 0) { s.wins++; s.gp += pnl; } else s.gl += -pnl;
  s.best = Math.max(s.best, pnl); s.worst = Math.min(s.worst, pnl); s.sumR += r;
  s.peak = Math.max(s.peak, st.bal); s.dd = Math.max(s.dd, (s.peak - st.bal) / s.peak * 100);
  st.eq.push({ t, b: +st.bal.toFixed(2) }); st.eq = st.eq.slice(-300);
  const maxR = st.cfg.rr, mfe = Math.min(maxR, p.mfe || 0);
  // ціль 2R або ручне закриття: «тінь» стежить далі, чи дійшла б ціна до 3R раніше за стоп — для навчання
  const resolved = why === 'стоп' || mfe >= maxR;
  const res = await db.prepare('INSERT INTO trades (dir, qty, entry, sl, tp, exit, opened, closed, pnl, r, why, exitWhy, setup, factors, rmul, mfe, tgtWhy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(p.dir, p.qty, p.entry, p.sl, p.tp, price, p.opened, t, +pnl.toFixed(2), +r.toFixed(2), p.why.slice(0, 400), why, p.setup || 'pull', JSON.stringify(p.factors || []), p.rMul || 0, resolved ? +mfe.toFixed(2) : null, (p.tgtWhy || '').slice(0, 400)).run();
  const id = res && res.meta && res.meta.last_row_id;
  if (!resolved && id) st.shadow.push({ id, dir: p.dir, entry: p.entry, sl: p.sl, R, mfe, until: t + 864e5 });
  log(st, t, `Закрито ${p.dir > 0 ? 'лонг' : 'шорт'} за ${f2(price)} (${why}): ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT, ${r.toFixed(2)}R`);
  st.pos = null;
}
async function trackShadows(db, st, path) {
  const keep = [];
  for (const s of st.shadow) {
    let done = false;
    for (const t of path) {
      if (s.dir * (t.p - s.sl) <= 0) { done = true; break; }
      s.mfe = Math.max(s.mfe, s.dir * (t.p - s.entry) / s.R);
      if (s.mfe >= st.cfg.rr) { done = true; break; }
      if (t.t > s.until) { done = true; break; }
    }
    if (done) await db.prepare('UPDATE trades SET mfe = ? WHERE id = ?').bind(+Math.min(st.cfg.rr, s.mfe).toFixed(2), s.id).run();
    else keep.push(s);
  }
  st.shadow = keep.slice(-20);
}

// Різниця «спот XAUUSD − ціна біржі»: додаємо до цін трейдера, щоб отримати ціну на графіку FOREX.com
function spotBasis(st, price) { return st.spot && Date.now() - st.spot.t < 30 * 6e4 ? +(st.spot.p - price).toFixed(2) : null; }

/* ================= ОДИН ЦИКЛ (кожну хвилину з розкладу) ================= */
export async function runTrader(db, now = Date.now()) {
  const st = await loadState(db), cfg = st.cfg, prevRun = st.run;
  st.run = now;
  let C, trades;
  try {
    const fresh = !prevRun || now - (st.lastT || 0) > 10 * 6e4;
    const m = await fetchMarket(st, fresh);
    if (m.src !== st.src) { if (st.src) log(st, now, `Джерело даних: ${SOURCES[m.src].name}`); st.lastId = 0; st.lastT = 0; }
    C = m.C; trades = m.trades; st.src = m.src; st.srcErr = m.errs; st.err = '';
  } catch (e) {
    st.err = `Немає даних з біржі: ${e && e.message}`;
    await saveState(db, st);
    return st;
  }
  if (now - (st.spotAt || 0) > 2 * 6e4) {   // спот XAUUSD (≈ FOREX.com) — раз на 2 хв
    st.spotAt = now;
    try { st.spot = await fetchSpot(); } catch (e) { st.spot = st.spot && now - st.spot.t < 30 * 6e4 ? st.spot : null; }
  }
  if (now - (st.calAt || 0) > (st.calErr ? 20 : 60) * 6e4) {   // календар ForexFactory: раз на годину, після відмови — через 20 хв
    st.calAt = now;
    try { st.cal = await fetchCalendar(now); st.calErr = ''; } catch (e) { st.calErr = String(e && e.message); if (st.cal && st.cal.length && st.cal[st.cal.length - 1].t < now) st.cal = []; }
  }
  if (trades.length) { st.lastId = trades[trades.length - 1].id || st.lastId; st.lastT = trades[trades.length - 1].t; }
  st.fp = addTrades(st.fp || {}, trades, cfg);
  const fund = await loadFund(db);
  // якщо ForexFactory недоступний з хмари — новини з фундаментального огляду Claude
  const cal = st.cal && st.cal.length ? st.cal : ((fund && fund.events) || []).filter(e => e.t > now - 36e5);

  // Аналіз зверху вниз
  const dayStart = Math.floor(now / 864e5) * 864e5, wd = (new Date(dayStart).getUTCDay() + 6) % 7, weekStart = dayStart - wd * 864e5;
  let day5 = C['5m'].filter(c => c.t >= dayStart); if (day5.length < 6) day5 = C['5m'].slice(-288);
  let week1 = C['1h'].filter(c => c.t >= weekStart); if (week1.length < 6) week1 = C['1h'].slice(-120);
  const vDay = vwap(day5), vWeek = vwap(week1), an = {};
  for (const tf of TFS) an[tf] = analyzeTF(tf, C[tf], ['4h', '2h'].includes(tf) ? vWeek : vDay);
  const bias = topDownBias(an), price = C['5m'][C['5m'].length - 1].c, atr5 = atr(C['5m'].slice(0, -1)), atr15 = atr(C['15m'].slice(0, -1));
  const pd = C['1h'].filter(c => c.t >= dayStart - 864e5 && c.t < dayStart), sw = C['15m'].slice(-49, -1);
  const extra = {
    prevDay: pd.length ? (() => { const h = Math.max(...pd.map(c => c.h)), l = Math.min(...pd.map(c => c.l)); return { h, l, mid: (h + l) / 2 }; })() : null,
    swing: sw.length ? (() => { const h = Math.max(...sw.map(c => c.h)), l = Math.min(...sw.map(c => c.l)); return { h, l, mid: (h + l) / 2 }; })() : null
  };
  const levels = keyLevels(an, vDay, extra), zones = buildZones(levels, Math.max(.5 * atr15, .3));

  // Супровід позиції: перший дотик стопу або цілі в стрічці угод (стоп перевіряється першим); MFE для навчання
  const path = trades.length ? trades : [{ p: price, t: now }];
  if (st.pos) {
    const p = st.pos, R = Math.abs(p.entry - p.sl);
    for (const t of path) {
      if (p.dir * (t.p - p.sl) <= 0) { await closePos(db, st, p.sl, t.t, 'стоп'); break; }
      p.mfe = Math.max(p.mfe || 0, p.dir * (t.p - p.entry) / R);
      if (p.dir * (t.p - p.tp) >= 0) { await closePos(db, st, p.tp, t.t, 'ціль'); break; }
    }
  }
  if (st.shadow.length) await trackShadows(db, st, path);
  // Нова закрита 5M свічка → оцінка входу
  const closed = C['5m'][C['5m'].length - 2];
  if (closed && closed.t !== st.lastBar5) {
    st.lastBar5 = closed.t;
    if (st.pos && st.pos.setup === 'pull' && st.pos.dir * bias <= -cfg.bias) await closePos(db, st, price, now, 'ухил змінився');
    if (!st.pos && cfg.on) {
      const learn = await learnStats(db, cfg);
      const s = findSetup({ bias, an, levels, zones, bar: closed, fpBar: st.fp.bars[closed.t], big: st.fp.big, c15: C['15m'].slice(0, -1), atr5, cfg, price, fund, cal, learn, now, basis: spotBasis(st, price) });
      if (s.dir) {
        const riskUsd = st.bal * cfg.risk / 100;
        let qty = Math.floor(riskUsd / Math.abs(s.entry - s.sl) / .001) * .001;
        qty = Math.min(qty, Math.floor(st.bal * 5 / s.entry / .001) * .001);   // плече не більше 5×
        if (qty >= .001) {
          st.pos = { dir: s.dir, qty: +qty.toFixed(3), entry: s.entry, sl: +s.sl.toFixed(2), tp: +s.tp.toFixed(2), opened: now, riskUsd: Math.abs(s.entry - s.sl) * qty,
            why: s.why, factors: s.factors, setup: s.setup, rMul: s.rMul, tgtWhy: s.tgtWhy, mfe: 0 };
          log(st, now, `Вхід ${s.why}. Ціна ${f2(s.entry)}, стоп ${f2(s.sl)}, ціль ${f2(s.tp)} (${s.rMul}R), обсяг ${qty.toFixed(3)} oz`);
        } else log(st, now, 'Сигнал є, але обсяг замалий для ризику');
      } else log(st, closed.t + BAR, `5M ${hhmm(closed.t)}: ${s.why}`);
    } else if (!cfg.on) log(st, closed.t + BAR, `5M ${hhmm(closed.t)}: трейдер на паузі`);
  }

  const lastFp = st.fp.bars[closed ? closed.t : 0], imb = imbalances(lastFp, cfg.imbRatio);
  st.an = {
    t: now, price, spot: st.spot ? +st.spot.p.toFixed(2) : null, basis: spotBasis(st, price), bias: +bias.toFixed(3), atr5: +atr5.toFixed(2), vDay: vDay && +vDay.v.toFixed(2), vWeek: vWeek && +vWeek.v.toFixed(2), est: Boolean(C['5m'][0].est),
    tfs: TFS.map(tf => { const a = an[tf]; return { tf, bias: a.bias, score: a.score, vwap: +a.vwap.toFixed(2), poc: +a.poc.toFixed(2), vah: +a.vah.toFixed(2), val: +a.val.toFixed(2), cvd: +a.cvd.toFixed(1), div: a.div, hvn: a.hvn.slice(0, 4).map(x => +x.toFixed(2)), lvn: a.lvn.slice(0, 4).map(x => +x.toFixed(2)) }; }),
    levels: levels.filter(l => Math.abs(l.p - price) < 12 * Math.max(atr5, .5)).map(l => ({ p: +l.p.toFixed(2), n: l.n, k: l.kind })),
    zones: zones.filter(z => Math.abs((z.lo + z.hi) / 2 - price) < 12 * Math.max(atr5, .5)).map(z => ({ lo: +z.lo.toFixed(2), hi: +z.hi.toFixed(2), count: z.count, names: z.names })),
    flow: lastFp ? { d: +lastFp.d.toFixed(1), v: +lastFp.v.toFixed(1), n: lastFp.n, ...imb } : null
  };
  if (st.pos) st.pos.upnl = +(st.pos.dir * (price - st.pos.entry) * st.pos.qty).toFixed(2);
  if (!st.eq.length || now - st.eq[st.eq.length - 1].t > 36e5) { st.eq.push({ t: now, b: +st.bal.toFixed(2) }); st.eq = st.eq.slice(-300); }
  await saveState(db, st);
  return st;
}

/* ================= ДЛЯ САЙТУ, ВЛАСТЕЛІНА І ТРЕНЕРА ================= */
const parseTrade = t => ({ ...t, factors: (() => { try { return JSON.parse(t.factors || '[]'); } catch { return []; } })() });
export async function traderTrades(db, limit = 200) {
  await ensureTraderSchema(db);
  const { results } = await db.prepare('SELECT * FROM trades ORDER BY id DESC LIMIT ?').bind(Math.min(500, Math.max(1, limit | 0))).all();
  return (results || []).map(parseTrade);
}
export async function traderView(db) {
  const st = await loadState(db), s = st.stats;
  const [trades, fund, learn, bySetup] = await Promise.all([traderTrades(db, 10), loadFund(db), learnStats(db, st.cfg), setupStats(db)]);
  const { results: cnt } = await db.prepare('SELECT COUNT(*) AS n FROM trades').all();
  return {
    cfg: st.cfg, bal: +st.bal.toFixed(2), pos: st.pos, src: st.src, err: st.err, run: st.run, since: st.since, an: st.an,
    stats: { n: s.n, wins: s.wins, winRate: s.n ? +(s.wins / s.n * 100).toFixed(1) : 0, pnl: +(st.bal - st.cfg.start).toFixed(2), pnlPct: +((st.bal / st.cfg.start - 1) * 100).toFixed(2),
      pf: s.gl ? +(s.gp / s.gl).toFixed(2) : (s.gp ? null : 0), dd: +s.dd.toFixed(2), best: +s.best.toFixed(2), worst: +s.worst.toFixed(2), avgR: s.n ? +(s.sumR / s.n).toFixed(2) : 0 },
    eq: st.eq, log: st.log.slice(0, 30), trades, total: (cnt && cnt[0] && cnt[0].n) || 0,
    big: (st.fp.big || []).slice(-15).reverse(), srcName: SOURCES[st.src] ? SOURCES[st.src].name : '', srcErr: st.srcErr || {},
    cal: ((st.cal && st.cal.length ? st.cal : (fund && fund.events) || [])).filter(e => e.t > Date.now() - 36e5).slice(0, 8), calSrc: st.cal && st.cal.length ? 'ForexFactory' : (fund && fund.events && fund.events.length ? 'ForexFactory через огляд Claude' : ''), calErr: st.calErr || '',
    fund, setups: Object.keys(SETUPS).map(k => ({ k, name: SETUPS[k], on: st.cfg[{ pull: 'sPull', zone: 'sZone', mid: 'sMid' }[k]], ...(bySetup[k] || { n: 0, wins: 0, avgR: 0, pnl: 0 }), learnN: learn[k].n, p2: +(learn[k].p2 * 100).toFixed(0), p3: +(learn[k].p3 * 100).toFixed(0) })),
    lessons: st.lessons
  };
}
export async function traderControl(db, b = {}) {
  const st = await loadState(db);
  if (b.action === 'start' || b.action === 'stop') { st.cfg.on = b.action === 'start'; log(st, Date.now(), st.cfg.on ? 'Трейдера запущено' : 'Трейдера поставлено на паузу'); }
  else if (b.action === 'config') { const on = st.cfg.on; st.cfg = cleanCfg({ ...(b.cfg || {}), on }, st.cfg); log(st, Date.now(), 'Налаштування змінено'); }
  else if (b.action === 'reset') {
    const cfg = st.cfg, lessons = st.lessons, fresh = freshState({ ...cfg });
    await db.prepare('DELETE FROM trades').run();
    fresh.bal = cfg.start; fresh.stats.peak = cfg.start; fresh.lessons = lessons;
    Object.assign(st, fresh); log(st, Date.now(), `Рахунок скинуто: ${cfg.start} USDT (уроки збережено)`);
  } else if (b.action === 'close') {
    if (!st.pos || !st.an) return { error: 'Немає відкритої позиції' };
    await closePos(db, st, st.an.price, Date.now(), 'закрито вручну');
  } else if (b.action === 'lesson-del') {
    const n = st.lessons.length; st.lessons = st.lessons.filter(l => l.id !== Number(b.id));
    if (st.lessons.length === n) return { error: 'Урок не знайдено' };
    log(st, Date.now(), 'Урок видалено');
  } else return { error: 'Невідома дія' };
  await saveState(db, st);
  return { ok: true };
}
// Тренер: запис уроку і/або зміна налаштувань (паперовий рахунок; усе видно в журналі)
const CFG_NAMES = { risk: 'ризик %', rr: 'базова ціль R', rr2: 'скорочена ціль R', minRR: 'мін. R до перешкоди', bigLot: 'велика угода, oz', imbRatio: 'імбаланс, разів', stack: 'стек імбалансів',
  tick: 'крок футпрінта', fee: 'комісія %', bias: 'поріг ухилу', tolAtr: 'допуск до рівня (ATR)', zoneMin: 'мін. рівнів у зоні', newsLock: 'пауза перед новинами, хв', learnMin: 'угод для навчання',
  sPull: 'сетап «відкат по тренду»', sZone: 'сетап «розворот від зони»', sMid: 'сетап «розворот від мід-поінта»', fundFilter: 'фільтр фундаменту' };
export async function traderTeach(db, i = {}) {
  const st = await loadState(db), done = [], t = Date.now();
  if (i.lesson && String(i.lesson).trim()) {
    const id = (st.lessons.reduce((m, l) => Math.max(m, l.id), 0) || 0) + 1;
    st.lessons.push({ id, text: String(i.lesson).trim().slice(0, 500), t }); st.lessons = st.lessons.slice(-40);
    done.push(`урок №${id} записано`);
  }
  if (i.remove_lesson) { st.lessons = st.lessons.filter(l => l.id !== Number(i.remove_lesson)); done.push(`урок №${i.remove_lesson} видалено`); }
  if (i.cfg && typeof i.cfg === 'object') {
    const before = st.cfg, after = cleanCfg({ ...i.cfg, on: before.on }, before);
    const ch = Object.keys(CFG_NAMES).filter(k => before[k] !== after[k]).map(k => `${CFG_NAMES[k]}: ${before[k]} → ${after[k]}`);
    st.cfg = after; if (ch.length) done.push('налаштування: ' + ch.join('; '));
  }
  if (!done.length) return 'Нічого не змінено.';
  log(st, t, 'Тренер: ' + done.join('; '));
  await saveState(db, st);
  return 'Готово: ' + done.join('; ') + '.';
}
// Коротке зведення для Властеліна/Тренера (інструмент trader_report)
export async function traderReport(db) {
  const v = await traderView(db), s = v.stats, a = v.an, c = v.cfg;
  if (!a) return 'Трейдер XAU ще не запускався (дані з’являться протягом хвилини).';
  return [
    `Трейдер XAU (паперова торгівля, ${c.on ? 'працює' : 'на паузі'}), джерело ${v.src || '—'}${v.err ? ', помилка: ' + v.err : ''}.`,
    `Баланс ${v.bal} USDT (старт ${c.start}), P/L ${s.pnl} (${s.pnlPct}%), угод ${s.n}, виграшних ${s.winRate}%, profit factor ${s.pf ?? '∞'}, макс. просідання ${s.dd}%, середнє ${s.avgR}R.`,
    `Налаштування: ${Object.keys(CFG_NAMES).map(k => `${k}=${c[k]}`).join(', ')}.`,
    'Сетапи: ' + v.setups.map(x => `${x.name} (${x.on ? 'увімк.' : 'вимк.'}): угод ${x.n}, виграшних ${x.wins}, сер. ${x.avgR}R; навчання ${x.learnN} угод, 2R досягали ${x.p2}%, 3R — ${x.p3}%`).join('; '),
    `Ціна ${a.price}, загальний ухил ${a.bias} (від −1 до +1), VWAP дня ${a.vDay}, тижня ${a.vWeek}.`,
    'ТФ: ' + a.tfs.map(t => `${t.tf} ${t.bias} (POC ${t.poc}, CVD ${t.cvd}${t.div ? ', дивергенція ' + t.div : ''})`).join('; '),
    'Зони: ' + ((a.zones || []).map(z => `${z.lo}–${z.hi} (${z.names.join('+')})`).join('; ') || 'немає'),
    v.fund ? `Фундамент (${new Date(v.fund.at).toISOString().slice(0, 16)}): ${v.fund.bias} — ${v.fund.summary}` : 'Фундаментального огляду ще немає.',
    'Новини США: ' + (v.cal.map(e => `${new Date(e.t).toISOString().slice(5, 16)} ${e.title} (${e.impact})`).join('; ') || 'немає даних'),
    v.pos ? `Відкрита позиція: ${v.pos.why}; вхід ${v.pos.entry}, стоп ${v.pos.sl}, ціль ${v.pos.tp} (${v.pos.rMul}R), P/L ${v.pos.upnl ?? '—'}.` : 'Позиції немає.',
    'Уроки власника: ' + (v.lessons.map(l => `№${l.id} ${l.text}`).join(' | ') || 'немає'),
    'Останні рішення: ' + v.log.slice(0, 6).map(l => l.text).join(' | '),
    'Останні угоди: ' + v.trades.slice(0, 8).map(t => `${t.dir > 0 ? 'L' : 'S'} ${t.setup} ${t.entry}→${t.exit} ${t.pnl} (${t.exitWhy}, ${t.rmul}R, MFE ${t.mfe ?? '…'})`).join('; ')
  ].join('\n');
}
