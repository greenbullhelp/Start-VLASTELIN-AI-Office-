// Тести рушія: node engine.test.mjs
import { readFileSync } from "node:fs";
import { newGame, play, attack, endTurn, aiTurn, canPlay } from "./src/engine.js";
const cards = JSON.parse(readFileSync(new URL("./cards.json", import.meta.url)));
let ok = 0; const t = (name, cond) => { if (!cond) { console.error("FAIL", name); process.exit(1); } ok++; console.log("PASS", name); };
const g = newGame(cards, 42);
t("старт: 30 HP, 1 золото, 4 карти в руці", g.players[0].hp === 30 && g.players[0].gold === 1 && g.players[0].hand.length === 4);
const cheap = g.players[0].hand.findIndex((c) => c.cost <= 1);
t("не можна зіграти дорожче за золото", g.players[0].hand.every((c, i) => c.cost <= 1 || !canPlay(g, 0, i)));
if (cheap >= 0) t("гра дешевої карти", play(g, 0, cheap));
endTurn(g); aiTurn(g, 1);
t("після ходу ШІ знову хід гравця з 2 золота", g.active === 0 && g.players[0].maxGold === 2);
// Захисник блокує атаку в героя
const s = newGame(cards, 7); const me = s.players[0], foe = s.players[1];
me.board.push({ ...cards.find((c) => c.name === "Вовк Високогір'я"), hp: 1, ready: true });
foe.board.push({ ...cards.find((c) => c.name === "Вартовий Корони"), hp: 2, ready: false });
t("захисник: атака в героя заборонена", attack(s, 0, 0, "hero") === false && foe.hp === 30);
t("атака в захисника дозволена", attack(s, 0, 0, 0) === true);
// Повна партія ШІ проти ШІ завершується
const w = newGame(cards, 99); let turns = 0; while (w.winner === null && turns < 200) { aiTurn(w, w.active); turns++; }
t("партія ШІ проти ШІ завершується переможцем", w.winner !== null);
console.log(`Усі ${ok} перевірок пройдено`);
