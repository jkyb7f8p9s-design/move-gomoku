/* AI 对 AI 浸泡测试：node tests/soak.js [局数] [每步预算ms] */
'use strict';
const E = require('../js/engine.js');
const AI = require('../js/ai.js');
const GAMES = +process.argv[2] || 120, BUDGET = +process.argv[3] || 40;
const levels = ['easy', 'medium', 'hard'];
const stats = { games: 0, byReason: {}, redWins: 0, blueWins: 0, draws: 0, firstWins: 0, turns: [], maxMoveMs: 0, boostTriggers: 0, errors: 0, matchups: {} };
const t0 = Date.now();
for (let i = 0; i < GAMES; i++) {
  const rng = E.mulberry32(1000 + i);
  const lr = levels[i % 3], lb = levels[Math.floor(i / 3) % 3];
  const g = new E.Game({}, { rng, first: i % 2 ? E.BLUE : E.RED });
  try {
    let guard = 0;
    while (!g.result) {
      if (++guard > 1000) throw new Error('疑似死循环');
      const before = JSON.stringify(g.serialize());
      const ts = Date.now();
      const m = AI.chooseMove(g, { level: g.current === E.RED ? lr : lb, timeBudget: BUDGET, rng });
      const dt = Date.now() - ts; if (dt > stats.maxMoveMs) stats.maxMoveMs = dt;
      if (JSON.stringify(g.serialize()) !== before) throw new Error('AI 状态残留');
      if (!m) throw new Error('无走法但对局未结束');
      const e = g.makeMove(m.from, m.to);
      if (e.boostStarted) stats.boostTriggers++;
      if (g.canOfferDraw() && g.noProgress >= 60) { g.agreeDraw(); } // 模拟双方在长期无进展后同意和棋
    }
    if (g.turn > 240) throw new Error('超过回合上限');
  } catch (err) { stats.errors++; console.error('第', i, '局出错：', err.message); continue; }
  stats.games++;
  const r = g.result; stats.byReason[r.reason] = (stats.byReason[r.reason] || 0) + 1;
  if (r.winner === 0) stats.draws++; else if (r.winner === E.RED) stats.redWins++; else stats.blueWins++;
  if (r.winner === g.firstPlayer) stats.firstWins++;
  const key = lr + '(红) vs ' + lb + '(蓝)';
  const mu = stats.matchups[key] || (stats.matchups[key] = { red: 0, blue: 0, draw: 0 });
  if (r.winner === 0) mu.draw++; else if (r.winner === E.RED) mu.red++; else mu.blue++;
  stats.turns.push(g.turn);
}
const avg = stats.turns.reduce((a, b) => a + b, 0) / (stats.turns.length || 1);
console.log(JSON.stringify({
  games: stats.games, errors: stats.errors, seconds: (Date.now() - t0) / 1000, redWins: stats.redWins, blueWins: stats.blueWins, draws: stats.draws,
  firstMoverWins: stats.firstWins, byReason: stats.byReason, avgTurns: +avg.toFixed(1), maxTurns: Math.max(...stats.turns), minTurns: Math.min(...stats.turns),
  boostTriggers: stats.boostTriggers, maxMoveMs: stats.maxMoveMs, matchups: stats.matchups
}, null, 1));
process.exit(stats.errors ? 1 : 0);
