// Інтерфейс прототипу: стіл, рука, атаки кліком, банерні слоти й кнопка донату (заглушки монетизації).
import { newGame, play, attack, endTurn, aiTurn, canPlay, taunts } from "./engine.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
let cards = [], g = null, selected = null;

async function boot() {
  cards = await fetch("./cards.json").then((r) => r.json());
  const cfg = await fetch("./monetization.json").then((r) => r.json()).catch(() => ({}));
  if (cfg.donation_url) { const d = $("#donate"); d.href = cfg.donation_url; d.hidden = false; }
  start();
}

function start() { g = newGame(cards); selected = null; $("#result").hidden = true; render(); }

function cardHtml(c, extra = "") {
  const art = c.art ? `<img src="./art/${esc(c.art)}" alt="">` : "";
  const stats = c.kind === "spell" ? "" : `<span class="atk">${c.attack ?? 0}</span><span class="hp">${c.hp ?? c.health}</span>`;
  return `<div class="card r-${c.rarity} ${extra}" title="${esc(c.text)}"><span class="cost">${c.cost}</span><div class="art">${art}</div>
    <b>${esc(c.name)}</b><small>${esc(c.text)}</small>${stats}</div>`;
}

function render() {
  const me = g.players[0], foe = g.players[1];
  $("#foeHero").textContent = `Суперник ♥ ${foe.hp} · ⬢ ${foe.gold}/${foe.maxGold} · карт ${foe.hand.length}`;
  $("#meHero").textContent = `Ви ♥ ${me.hp} · ⬢ ${me.gold}/${me.maxGold} · колода ${me.deck.length}`;
  const guard = taunts(foe);
  $("#foeBoard").innerHTML = foe.board.map((u, i) => `<div data-foe="${i}">${cardHtml(u, selected !== null && (!guard.length || guard.includes(u)) ? "target" : "")}</div>`).join("");
  $("#myBoard").innerHTML = me.board.map((u, i) => `<div data-mine="${i}">${cardHtml(u, (u.ready && !u.frozen && u.kind !== "building" ? "ready" : "") + (selected === i ? " sel" : ""))}</div>`).join("");
  $("#hand").innerHTML = me.hand.map((c, i) => `<div data-hand="${i}">${cardHtml(c, canPlay(g, 0, i) ? "playable" : "")}</div>`).join("");
  $("#foeHero").classList.toggle("target", selected !== null && !guard.length);
  $("#log").innerHTML = g.log.slice(-6).map(esc).join("<br>");
  if (g.winner !== null) { $("#result").hidden = false; $("#resultText").textContent = g.winner === 0 ? "Перемога!" : "Поразка"; }
}

document.addEventListener("click", (e) => {
  const h = e.target.closest("[data-hand]"), m = e.target.closest("[data-mine]"), f = e.target.closest("[data-foe]");
  if (h) { play(g, 0, +h.dataset.hand); selected = null; }
  else if (m) { selected = selected === +m.dataset.mine ? null : +m.dataset.mine; }
  else if (f && selected !== null) { attack(g, 0, selected, +f.dataset.foe); selected = null; }
  else if (e.target.closest("#foeHero") && selected !== null) { attack(g, 0, selected, "hero"); selected = null; }
  render();
});
$("#endTurn").addEventListener("click", () => { selected = null; endTurn(g); render(); setTimeout(() => { aiTurn(g, 1); render(); }, 450); });
$("#again").addEventListener("click", start);
boot();
