// Розділ «Ринок»: золото XAU — графік, індикатори, рівні, сигнали; демо-торгівля з лімітами ризику.
import { api, act, card, esc, money, fmtTime, empty, R, A, render, go, input, toast } from "/static/app.js?v=1";

const side = (s) => (s === "long" ? '<span class="ok">LONG ▲</span>' : '<span class="bad">SHORT ▼</span>');

R.market = async () => {
  const m = await api("/api/market");
  const ind = m.ind || {};
  const acc = m.account;
  const lim = m.limits;
  const src = m.error ? `<span class="bad">${esc(m.error)}</span>` : `${esc(m.source || "—")}${m.updated ? " · " + fmtTime(m.updated) : ""}`;
  return `<div class="grid">
    ${card("Золото XAU", `<div class="row between"><div><div class="big">${m.price ? Number(m.price).toFixed(2) : "—"}</div>
        <div class="m muted">XAU/USDT ф'ючерс · ${src}</div></div>
        <div style="text-align:right"><div class="${(ind.change_day || 0) >= 0 ? "ok" : "bad"}">${ind.ready ? (ind.change_day >= 0 ? "+" : "") + ind.change_day + "% за добу" : ""}</div>
        ${m.spot ? `<div class="m muted">Спот XAU/USD ${Number(m.spot).toFixed(2)}${m.basis !== undefined ? ` (різниця ${m.basis >= 0 ? "+" : ""}${m.basis})` : ""}</div>` : ""}</div></div>
      <canvas class="chart" id="pxChart" style="height:260px;margin-top:10px"></canvas>
      <div class="m dim">15M свічки · <span style="color:#4cc2ff">EMA20</span> · <span class="gold">EMA50</span></div>`,
      `<button class="btn sm" id="mRefresh">Оновити</button>`, "wide")}
    ${card("Аналітика", ind.ready ? `<div class="kpis">
        <div class="kpi"><b>${esc(ind.trend)}</b><span>тренд 15M</span></div><div class="kpi"><b>${ind.rsi}</b><span>RSI 14</span></div>
        <div class="kpi"><b>${ind.atr}</b><span>ATR 14</span></div><div class="kpi"><b>${ind.day_low}–${ind.day_high}</b><span>діапазон доби</span></div></div>
        <div class="m" style="margin-top:10px">Опір: <span class="bad">${(ind.resistance || []).join(" · ") || "—"}</span></div>
        <div class="m">Підтримка: <span class="ok">${(ind.support || []).join(" · ") || "—"}</span></div>`
      : empty(`Збираю дані (${ind.bars || 0} свічок)… Потрібен доступ сервера до Binance або OKX.`),
      `<button class="btn sm gold" id="mAnalyze">Аналіз від агента</button>`)}
    ${acc ? card("Демо-рахунок", `<div class="kpis">
        <div class="kpi"><b>${money(acc.balance)}</b><span>баланс</span></div><div class="kpi"><b>${money(acc.equity)}</b><span>з відкритими</span></div>
        <div class="kpi"><b class="${acc.day_pnl >= 0 ? "ok" : "bad"}">${money(acc.day_pnl)}</b><span>сьогодні</span></div>
        <div class="kpi"><b>${acc.win_rate !== null ? acc.win_rate + "%" : "—"}</b><span>виграшних (${acc.closed})</span></div></div>
        ${acc.halted ? `<div class="m bad" style="margin-top:8px">⛔ Торгівлю зупинено до завтра: ${esc(acc.halted)}</div>` : ""}
        <div class="row" style="margin-top:10px"><label class="row"><input type="checkbox" id="autoTrade" ${m.enabled ? "checked" : ""} style="width:auto"> Демо-торгівля за сигналами</label></div>
        <div class="m dim">Лише демо. Реальні угоди — тільки з вашого підтвердження, брокер не підключено.</div>`) : ""}
    ${lim ? card("Ліміти ризику", `<form id="limForm" class="form">
        <div><label class="f">Макс. позиція, унцій</label><input type="number" step="0.1" min="0.1" name="max_position_oz" value="${lim.max_position_oz}"></div>
        <div><label class="f">Ризик на угоду, %</label><input type="number" step="0.1" min="0.1" max="5" name="risk_pct" value="${lim.risk_pct}"></div>
        <div><label class="f">Денний ліміт збитку, $</label><input type="number" step="1" min="1" name="daily_loss_usd" value="${lim.daily_loss_usd}"></div>
        <div><label class="f">Ціль, R</label><input type="number" step="0.5" min="1" max="5" name="rr" value="${lim.rr}"></div>
        <div><label class="f">Стоп, × ATR</label><input type="number" step="0.1" min="0.5" max="5" name="atr_mult" value="${lim.atr_mult}"></div>
        <div><label class="f">Макс. угод за день</label><input type="number" step="1" min="1" max="20" name="max_trades_day" value="${lim.max_trades_day}"></div>
        <button class="btn primary">Зберегти</button></form>
        <div class="m dim" style="margin-top:6px">Кожна угода має обов'язковий стоп. При досягненні денного ліміту збитку всі позиції закриваються, торгівля стоїть до завтра. Агенти змінити ліміти не можуть — лише ви.</div>`) : ""}
    ${acc ? card("Відкриті позиції", m.open.length ? `<table class="t"><tr><th>#</th><th>Напрям</th><th>Обсяг</th><th>Вхід</th><th>Стоп</th><th>Ціль</th><th>P/L</th><th></th></tr>
        ${m.open.map((t) => `<tr><td>${t.id}</td><td>${side(t.side)}</td><td>${t.size} oz</td><td>${t.entry}</td><td class="bad">${t.stop}</td><td class="ok">${t.target}</td>
        <td class="${t.upnl >= 0 ? "ok" : "bad"}">${money(t.upnl)}</td><td><button class="btn sm danger" data-close="${t.id}">Закрити</button></td></tr>`).join("")}</table>`
      : empty("Відкритих позицій немає."), "", "wide") : ""}
    ${card("Сигнали", (m.signals || []).length ? `<div class="list">${m.signals.map((s) => `<div class="item"><div class="row between"><span>${side(s.side)} від ${s.entry}</span><span class="tag">${{ new: "новий", taken: "виконано", skipped: "пропущено" }[s.status] || esc(s.status)}</span></div>
        <div class="m">Стоп ${s.stop} · ціль ${s.target} · ${fmtTime(s.ts)} · ${esc(s.source)}</div><div class="m muted">${esc(s.reason)}</div></div>`).join("")}</div>`
      : empty("Сигналів поки немає. Умови: тренд за EMA20/EMA50 і завершення відкату за RSI."))}
    ${acc ? card("Журнал угод", m.journal.length ? `<table class="t"><tr><th>#</th><th>Напрям</th><th>Вхід → вихід</th><th>Обсяг</th><th>P/L</th><th>Причина</th><th>Закрито</th></tr>
        ${m.journal.map((t) => `<tr><td>${t.id}</td><td>${side(t.side)}</td><td>${t.entry} → ${t.exit ?? "—"}</td><td>${t.size}</td><td class="${t.pnl >= 0 ? "ok" : "bad"}">${money(t.pnl)}</td><td class="muted">${esc(t.close_reason)}</td><td class="dim">${t.closed ? fmtTime(t.closed) : ""}</td></tr>`).join("")}</table>`
      : empty("Угод ще не було."), "", "wide") : ""}
  </div>`;
};

A.market = () => {
  drawPrice();
  document.querySelector("#mRefresh")?.addEventListener("click", async () => { const r = await act(() => api("/api/market/refresh", { method: "POST" })); if (r && !r.ok) toast("⚠ " + r.error, 5000); render(true); });
  document.querySelector("#mAnalyze")?.addEventListener("click", () => { go("chat"); input.value = "Доручи трейдинговому агенту: свіжий аналіз золота (тренд, рівні, новини дня), чи є сетап на демо-рахунку."; input.focus(); });
  document.querySelector("#autoTrade")?.addEventListener("change", async (e) => { await act(() => api("/api/trading/enabled", { method: "POST", body: { enabled: e.target.checked } }), e.target.checked ? "Демо-торгівлю увімкнено" : "Демо-торгівлю вимкнено"); render(true); });
  document.querySelector("#limForm")?.addEventListener("submit", async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); for (const k in f) f[k] = +f[k];
    await act(() => api("/api/trading/limits", { method: "POST", body: f }), "Ліміти збережено"); render(true); });
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", async () => { if (!confirm("Закрити позицію за ринком?")) return; await act(() => api(`/api/trading/close/${b.dataset.close}`, { method: "POST" }), "Закрито"); render(true); }));
};

let cache = null;
async function drawPrice() {
  const cv = document.querySelector("#pxChart"); if (!cv) return;
  const m = cache = await api("/api/market").catch(() => cache); if (!m) return;
  const cs = m.candles || []; const dpr = window.devicePixelRatio || 1;
  cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr;
  const g = cv.getContext("2d"), W = cv.width, H = cv.height, pad = 8 * dpr, right = 54 * dpr;
  if (cs.length < 2) { g.fillStyle = "#5d6b84"; g.font = `${12 * dpr}px sans-serif`; g.fillText("Немає даних", pad, H / 2); return; }
  const closes = cs.map((c) => c.c), ema = (n) => { const k = 2 / (n + 1); let e = closes[0]; return closes.map((v) => (e = v * k + e * (1 - k))); };
  const e20 = ema(20), e50 = ema(50);
  const lo = Math.min(...cs.map((c) => c.l)), hi = Math.max(...cs.map((c) => c.h)), span = hi - lo || 1;
  const y = (v) => pad + (1 - (v - lo) / span) * (H - pad * 2), bw = (W - right) / cs.length;
  g.strokeStyle = "rgba(143,160,190,.08)"; g.lineWidth = 1; g.font = `${10 * dpr}px sans-serif`; g.fillStyle = "#5d6b84";
  for (let i = 0; i <= 4; i++) { const v = lo + (span * i) / 4, yy = y(v); g.beginPath(); g.moveTo(0, yy); g.lineTo(W - right, yy); g.stroke(); g.fillText(v.toFixed(1), W - right + 4 * dpr, yy + 3 * dpr); }
  cs.forEach((c, i) => { const x = i * bw + bw / 2, up = c.c >= c.o; g.strokeStyle = g.fillStyle = up ? "rgba(60,207,145,.85)" : "rgba(239,91,91,.85)";
    g.beginPath(); g.moveTo(x, y(c.h)); g.lineTo(x, y(c.l)); g.stroke(); const top = y(Math.max(c.o, c.c)), h = Math.max(1, Math.abs(y(c.o) - y(c.c))); g.fillRect(x - bw * .33, top, bw * .66, h); });
  const line = (arr, color) => { g.strokeStyle = color; g.lineWidth = 1.4 * dpr; g.beginPath(); arr.forEach((v, i) => (i ? g.lineTo(i * bw + bw / 2, y(v)) : g.moveTo(bw / 2, y(v)))); g.stroke(); };
  line(e20, "rgba(76,194,255,.9)"); line(e50, "rgba(230,204,138,.85)");
  (m.open || []).forEach((t) => { [[t.entry, "rgba(243,245,248,.6)"], [t.stop, "rgba(239,91,91,.8)"], [t.target, "rgba(60,207,145,.8)"]].forEach(([v, col]) => {
    if (v < lo || v > hi) return; g.setLineDash([5 * dpr, 4 * dpr]); g.strokeStyle = col; g.lineWidth = dpr; g.beginPath(); g.moveTo(0, y(v)); g.lineTo(W - right, y(v)); g.stroke(); g.setLineDash([]); }); });
  const last = cs[cs.length - 1].c; g.fillStyle = "#4cc2ff"; g.fillRect(W - right, y(last) - 8 * dpr, right, 16 * dpr); g.fillStyle = "#07090d"; g.fillText(last.toFixed(2), W - right + 4 * dpr, y(last) + 4 * dpr);
}
window.addEventListener("resize", () => document.querySelector("#pxChart") && drawPrice());

export function install() {}
