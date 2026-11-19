// Розділ «Гра та бізнес»: документи й сценарій (імпорт з VLASTELIN), каталог карток з графікою, монетизація, задачі ігровому агенту.
import { api, act, card, esc, empty, bar, R, A, render, toast } from "/static/app.js?v=1";

const RAR = { common: "звичайна", rare: "рідкісна", epic: "епічна", legendary: "легендарна" };
const KIND = { unit: "боєць", spell: "заклинання", building: "споруда" };
const ART = { none: "без графіки", queued: "в черзі на ПК", done: "готово", error: "помилка" };

R.game = async () => {
  const g = await api("/api/game");
  const m = g.monetization;
  return `<div class="grid">
    ${card("Ігровий агент", `<div class="m muted">Доручіть типову задачу — Джарвіс передасть її ігровому агенту, Контролер перевірить результат.</div>
      <div class="row" style="flex-wrap:wrap;margin-top:10px">
        <button class="btn sm gold" data-gtask="architecture">Архітектура гри</button><button class="btn sm" data-gtask="balance">Баланс карток</button>
        <button class="btn sm" data-gtask="code">Наступна фіча (код)</button><button class="btn sm" data-gtask="monetization">Монетизація</button>
        <button class="btn sm" data-gtask="cards">Нові картки + графіка</button></div>`, "", "wide")}
    ${card("Сценарій і документи", `${g.docs.length ? `<div class="list">${g.docs.map((d) => `<div class="item"><div class="row between"><div class="t">${esc(d.title)}</div><span class="tag">${d.source === "vlastelin" ? "VLASTELIN" : "ваш"}</span></div>
        <div class="m muted">${esc(d.preview)}${d.size > 400 ? "…" : ""}</div><div class="row" style="margin-top:6px"><button class="btn sm" data-dopen="${d.id}">Читати</button><button class="btn sm danger" data-ddel="${d.id}">Видалити</button></div></div>`).join("")}</div>`
      : empty("Сценарій ще не імпортовано. Завантажте файл експорту з VLASTELIN (див. інструкцію docs/GAME.md) або вставте текст.")}
      <form id="impForm" class="row" style="margin-top:10px;flex-wrap:wrap"><input type="file" name="file" accept=".json,.txt,.md" style="width:auto"><button class="btn sm primary">Імпорт з VLASTELIN</button></form>
      <details style="margin-top:8px"><summary class="muted" style="cursor:pointer">Вставити текст вручну</summary>
      <form id="docForm" class="stack" style="margin-top:8px"><input name="title" placeholder="Назва документа" maxlength="120" required><textarea name="body" rows="6" placeholder="Текст сценарію, правила, світ…" required></textarea><button class="btn sm primary">Зберегти</button></form></details>`)}
    ${card("Монетизація", `<div class="m"><b>Донати:</b> ${m.donations.map(esc).join(" · ")}</div><div class="m" style="margin-top:4px"><b>Банери:</b> ${m.ad_slots.map(esc).join(" · ")}</div>
      <div class="m muted" style="margin-top:4px">${esc(m.rules)}</div>
      <form id="monForm" class="row" style="margin-top:10px"><input name="donation_url" placeholder="https://… посилання для донатів" value="${esc(m.donation_url)}"><button class="btn sm primary">Зберегти</button></form>`)}
    ${card(`Каталог карток · ${g.stats.cards}`, `<div class="row between" style="margin-bottom:10px"><span class="m muted">з графікою: ${g.stats.with_art} з ${g.stats.cards}</span><div style="flex:1;max-width:240px">${bar(g.stats.cards ? (g.stats.with_art / g.stats.cards) * 100 : 0, "gold")}</div></div>
      ${g.cards.length ? `<div class="cards">${g.cards.map((c) => `<div class="gcard r-${c.rarity}"><div class="art">${c.art ? `<img loading="lazy" src="/api/game/art/${encodeURIComponent(c.art)}" alt="${esc(c.name)}">` : esc(ART[c.art_status] || c.art_status)}</div>
        <div class="info"><b>${esc(c.name)}</b><span class="muted">${esc(c.faction)} · ${KIND[c.kind] || c.kind} · ${RAR[c.rarity] || c.rarity}</span>
        <div>⬢ ${c.cost}${c.kind === "unit" ? ` · ⚔ ${c.attack} · ♥ ${c.health}` : c.kind === "building" ? ` · ♥ ${c.health}` : ""}</div><div class="muted">${esc(c.text)}</div>
        <div class="row" style="margin-top:6px"><button class="btn sm" data-art="${c.id}">${c.art ? "Перемалювати" : "Намалювати"}</button><button class="btn sm danger" data-cdel="${c.id}">✕</button></div></div></div>`).join("")}</div>`
      : empty("Каталог порожній.")}
      <div class="row" style="margin-top:10px"><button class="btn sm" id="seed">Додати стартовий набір (12 карток)</button></div>`,
      `<span class="m dim">графіку малює ПК-вузол</span>`, "wide")}
    ${g.jobs.length ? card("Черга графіки", `<div class="list">${g.jobs.map((j) => `<div class="item"><div class="row between"><span>#${j.id} ${esc(j.ref)}</span><span class="tag ${j.status === "done" ? "done" : j.status === "error" ? "failed" : "queued"}">${esc(j.status)}</span></div>${j.error ? `<div class="m bad">${esc(j.error)}</div>` : ""}</div>`).join("")}</div>`) : ""}
    ${card("Бізнес-проєкти", g.projects.length ? `<div class="list">${g.projects.map((p) => `<div class="item"><div class="row between"><span class="t">${esc(p.name)}</span><span class="muted">${p.progress}%</span></div>${bar(p.progress, "gold")}</div>`).join("")}</div>` : empty("Проєктів ще немає (розділ «Проєкти»)."))}
  </div>`;
};

A.game = () => {
  const $ = (s) => document.querySelector(s), $$ = (s) => document.querySelectorAll(s);
  $$("[data-gtask]").forEach((b) => b.addEventListener("click", async () => { const r = await act(() => api("/api/game/agent", { method: "POST", body: { kind: b.dataset.gtask } })); if (r) toast(`Задачу #${r.task_id} передано Джарвісу`); }));
  $("#impForm").addEventListener("submit", async (e) => { e.preventDefault(); const f = e.target.file.files[0]; if (!f) return toast("Виберіть файл");
    const fd = new FormData(); fd.append("file", f); const r = await act(() => api("/api/game/import", { method: "POST", body: fd })); if (r) toast(`Імпортовано документів: ${r.imported}`); render(); });
  $("#docForm").addEventListener("submit", async (e) => { e.preventDefault(); await act(() => api("/api/game/docs", { method: "POST", body: { title: e.target.title.value, body: e.target.body.value } }), "Збережено"); render(); });
  $("#monForm").addEventListener("submit", async (e) => { e.preventDefault(); await act(() => api("/api/game/monetization", { method: "POST", body: { donation_url: e.target.donation_url.value } }), "Збережено"); });
  $$("[data-dopen]").forEach((b) => b.addEventListener("click", async () => { const d = await api(`/api/game/docs/${b.dataset.dopen}`); const item = b.closest(".item"); item.querySelector(".m").outerHTML = `<pre>${esc(d.body)}</pre>`; b.remove(); }));
  $$("[data-ddel]").forEach((b) => b.addEventListener("click", async () => { if (!confirm("Видалити документ?")) return; await act(() => api(`/api/game/docs/${b.dataset.ddel}`, { method: "DELETE" })); render(true); }));
  $$("[data-art]").forEach((b) => b.addEventListener("click", async () => { const r = await act(() => api(`/api/game/cards/${b.dataset.art}/art`, { method: "POST" })); if (r) toast(r.note, 5000); render(true); }));
  $$("[data-cdel]").forEach((b) => b.addEventListener("click", async () => { if (!confirm("Видалити картку?")) return; await act(() => api(`/api/game/cards/${b.dataset.cdel}`, { method: "DELETE" })); render(true); }));
  $("#seed").addEventListener("click", async () => { const r = await act(() => api("/api/game/seed", { method: "POST" })); if (r) toast(`Додано карток: ${r.added}`); render(true); });
};

export function install() {}
