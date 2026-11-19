// Рушій правил «Властелін: карткова гра». Чиста логіка без DOM — легко тестувати й розвивати.
// Правила прототипу: 30 HP у героя, золото +1 за хід (до 10), рука до 7 карт, на столі до 6 бійців.
// Бійці атакують наступного ходу (крім «Ривка»), «Захисник» мусить бути атакований першим.

export const MAX_GOLD = 10, HAND_MAX = 7, BOARD_MAX = 6, HERO_HP = 30;

export function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

export function makeDeck(cards, rand, size = 20) {
  const pool = cards.filter((c) => c.kind !== "building" || c.rarity !== "legendary");
  const deck = [];
  while (deck.length < size) deck.push({ ...pool[Math.floor(rand() * pool.length)], uid: Math.random().toString(36).slice(2) });
  return deck;
}

export function newGame(cards, seed = Date.now()) {
  const rand = rng(seed);
  const side = () => ({ hp: HERO_HP, gold: 0, maxGold: 0, deck: makeDeck(cards, rand), hand: [], board: [], fatigue: 0 });
  const g = { turn: 0, active: 0, players: [side(), side()], log: [], winner: null, rand };
  for (let i = 0; i < 3; i++) { draw(g, 0); draw(g, 1); }
  draw(g, 1);
  startTurn(g);
  return g;
}

export function draw(g, p) {
  const pl = g.players[p];
  if (!pl.deck.length) { pl.fatigue += 1; damageHero(g, p, pl.fatigue, "втома"); return; }
  const c = pl.deck.pop();
  if (pl.hand.length < HAND_MAX) pl.hand.push(c);
}

export function startTurn(g) {
  const pl = g.players[g.active];
  g.turn += 1;
  pl.maxGold = Math.min(MAX_GOLD, pl.maxGold + 1);
  pl.gold = pl.maxGold;
  pl.board.forEach((u) => { u.ready = true; u.frozen = Math.max(0, (u.frozen || 0) - 1); });
  pl.board.filter((u) => u.name === "Цитадель Властеліна").forEach(() => { pl.gold = Math.min(MAX_GOLD, pl.gold + 1); });
  draw(g, g.active);
}

export function endTurn(g) {
  if (g.winner !== null) return;
  g.active = 1 - g.active;
  startTurn(g);
}

function damageHero(g, p, n, why) {
  const pl = g.players[p];
  pl.hp -= n;
  g.log.push(`${p === 0 ? "Ви" : "Суперник"}: −${n} HP (${why})`);
  if (pl.hp <= 0) g.winner = 1 - p;
}

export function canPlay(g, p, idx) {
  const pl = g.players[p], c = pl.hand[idx];
  return g.winner === null && g.active === p && c && c.cost <= pl.gold && (c.kind === "spell" || pl.board.length < BOARD_MAX);
}

export function play(g, p, idx, target = null) {
  if (!canPlay(g, p, idx)) return false;
  const pl = g.players[p], foe = g.players[1 - p], c = pl.hand.splice(idx, 1)[0];
  pl.gold -= c.cost;
  if (c.kind === "spell") {
    if (/Завдайте 3 шкоди/.test(c.text)) {
      const t = target ?? foe.board.findIndex((u) => u.hp <= 3);
      if (t >= 0 && foe.board[t]) { foe.board[t].hp -= 3; cleanup(g); } else damageHero(g, 1 - p, 3, c.name);
    } else if (/Візьміть 1 карту/.test(c.text)) { draw(g, p); if (pl.board.some((u) => u.kind === "building")) draw(g, p); }
    else draw(g, p);
  } else {
    const u = { ...c, hp: c.health, ready: /Ривок/.test(c.text), frozen: 0 };
    pl.board.push(u);
    if (/заморозьте/.test(c.text) && foe.board.length) foe.board[0].frozen = 2;
  }
  g.log.push(`${p === 0 ? "Ви" : "Суперник"} зіграли «${c.name}»`);
  return true;
}

export function taunts(pl) { return pl.board.filter((u) => /Захисник/.test(u.text)); }

export function attack(g, p, from, to) {
  const pl = g.players[p], foe = g.players[1 - p], a = pl.board[from];
  if (g.winner !== null || g.active !== p || !a || !a.ready || a.frozen || a.kind === "building" || a.attack <= 0) return false;
  const guard = taunts(foe);
  if (to === "hero") {
    if (guard.length) return false;
    damageHero(g, 1 - p, a.attack, a.name);
  } else {
    const d = foe.board[to];
    if (!d || (guard.length && !guard.includes(d))) return false;
    const dmg = (x, n) => Math.max(0, n - (/на 1 шкоди менше/.test(x.text) ? 1 : 0));
    d.hp -= dmg(d, a.attack); a.hp -= dmg(a, d.attack || 0);
  }
  a.ready = false;
  cleanup(g);
  return true;
}

function cleanup(g) {
  g.players.forEach((pl, p) => {
    pl.board = pl.board.filter((u) => {
      if (u.hp > 0) return true;
      if (/Коли гине: завдає 1 шкоди/.test(u.text)) damageHero(g, 1 - p, 1, u.name);
      return false;
    });
  });
}

// Простий ШІ суперника: грає найдорожче, що може, атакує вигідно або в героя.
export function aiTurn(g, p = 1) {
  let moved = true;
  while (moved && g.winner === null) {
    moved = false;
    const pl = g.players[p];
    const order = pl.hand.map((c, i) => [c.cost, i]).sort((a, b) => b[0] - a[0]);
    for (const [, i] of order) if (canPlay(g, p, i)) { play(g, p, i); moved = true; break; }
  }
  const pl = g.players[p], foe = g.players[1 - p];
  pl.board.forEach((_, i) => {
    const a = pl.board[i]; if (!a || !a.ready) return;
    const guard = taunts(foe);
    if (guard.length) { attack(g, p, i, foe.board.indexOf(guard[0])); return; }
    const kill = foe.board.findIndex((d) => d.hp <= a.attack && (d.attack || 0) < a.hp);
    attack(g, p, i, kill >= 0 ? kill : "hero");
  });
  endTurn(g);
}
