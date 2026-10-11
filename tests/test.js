/* 纯逻辑单元测试：node tests/test.js */
'use strict';
const assert = require('assert');
const E = require('../js/engine.js');
const AI = require('../js/ai.js');
const { Game, RED, BLUE, EMPTY } = E;
const S = 10, P = (r, c) => r * S + c;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n    ' + (e && e.stack || e)); }
}
// 构造局面：stones = {red:[[r,c]...], blue:[...]}
function make(red, blue, opts) {
  const grid = new Uint8Array(100);
  red.forEach(([r, c]) => grid[P(r, c)] = RED);
  blue.forEach(([r, c]) => grid[P(r, c)] = BLUE);
  return new Game(Object.assign({}, opts && opts.cfg), { grid, first: (opts && opts.first) || RED });
}
const filler = [[9, 0], [9, 2], [9, 4], [9, 6], [9, 8]]; // 蓝方散子，保证有可走步

console.log('胜利判定');
test('横向 5 连（显式 check_win(pos, player)）', () => {
  const g = make([[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]], filler);
  assert.deepStrictEqual(g.check_win(P(0, 2), RED), [0, 1, 2, 3, 4]);
  assert.strictEqual(g.check_win(P(0, 2), BLUE), null);
});
test('纵向 / 两条斜向 / 边界 / 6 连也算', () => {
  let g = make([[5, 9], [6, 9], [7, 9], [8, 9], [9, 9]], [[0, 0]]);
  assert.ok(g.checkWin(P(9, 9), RED));
  g = make([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]], [[9, 0]]);
  assert.ok(g.checkWin(P(4, 4), RED));
  g = make([[0, 9], [1, 8], [2, 7], [3, 6], [4, 5]], [[9, 0]]);
  assert.ok(g.checkWin(P(2, 7), RED));
  g = make([[3, 0], [3, 1], [3, 2], [3, 3], [3, 4], [3, 5]], [[9, 0]]);
  assert.strictEqual(g.checkWin(P(3, 5), RED).length, 6);
});
test('4 连不胜、断开不胜', () => {
  let g = make([[0, 0], [0, 1], [0, 2], [0, 3]], filler);
  assert.strictEqual(g.checkWin(P(0, 3), RED), null);
  g = make([[0, 0], [0, 1], [0, 3], [0, 4], [0, 5]], filler);
  assert.strictEqual(g.checkWin(P(0, 4), RED), null);
});
test('走子成五 → result 胜利并含连线', () => {
  const g = make([[0, 0], [0, 1], [0, 2], [0, 3], [1, 4]], filler);
  g.makeMove(P(1, 4), P(0, 4));
  assert.strictEqual(g.result.winner, RED);
  assert.strictEqual(g.result.reason, 'five');
  assert.deepStrictEqual(g.result.line, [0, 1, 2, 3, 4]);
});

console.log('合法移动');
test('普通回合只能横竖 1 格、目标须空', () => {
  const g = make([[5, 5], [5, 6]], filler);
  const t = g.targets(P(5, 5)).sort((a, b) => a - b);
  assert.deepStrictEqual(t, [P(4, 5), P(5, 4), P(6, 5)]);
  assert.strictEqual(g.explainIllegal(P(5, 5), P(6, 6)), '只能横向或纵向移动');
  assert.strictEqual(g.explainIllegal(P(5, 5), P(5, 6)), '目标格已有棋子');
  assert.strictEqual(g.explainIllegal(P(5, 5), P(3, 5)), '普通回合只能移动 1 格');
  assert.strictEqual(g.explainIllegal(P(9, 0), P(8, 0)), '只能移动己方棋子');
  assert.throws(() => g.makeMove(P(5, 5), P(3, 5)));
});
test('加速回合可走 2 格，中间被堵则不可', () => {
  const g = make([[5, 5], [5, 7]], [[4, 5], [9, 0]]);
  g.boostLeft = 3;
  const t = g.targets(P(5, 5));
  assert.ok(t.includes(P(5, 3)) && t.includes(P(5, 4)) && t.includes(P(5, 6)) && t.includes(P(6, 5)) && t.includes(P(7, 5)));
  assert.ok(!t.includes(P(3, 5)), '上方被蓝子挡住，2 格也不可');
  assert.strictEqual(g.explainIllegal(P(5, 5), P(3, 5)), '路径被阻挡');
  assert.ok(!g.targets(P(5, 7)).includes(P(5, 5)));
  assert.strictEqual(g.explainIllegal(P(5, 5), P(5, 8)), '加速模式最多移动 2 格');
  assert.ok(g.isLegal(P(5, 5), P(7, 5)));
});
test('边界：角落棋子不会越界', () => {
  const g = make([[0, 0]], [[9, 9]]);
  g.boostLeft = 1;
  assert.deepStrictEqual(g.targets(P(0, 0)).sort((a, b) => a - b), [P(0, 1), P(0, 2), P(1, 0), P(2, 0)]);
  const g2 = make([[0, 9]], [[9, 9]]);
  assert.ok(!g2.targets(P(0, 9)).includes(P(1, 0)), '不能卷到下一行');
});
test('无合法移动即判负', () => {
  // 红子被困在角落：[0,0] 周围 [0,1],[1,0] 是蓝子；蓝走一步后红无路可走
  const g = make([[0, 0]], [[0, 1], [1, 0], [5, 5]], { first: BLUE });
  g.makeMove(P(5, 5), P(5, 6));
  assert.strictEqual(g.result.reason, 'blocked');
  assert.strictEqual(g.result.winner, BLUE);
  assert.strictEqual(g.result.loser, RED);
});

console.log('悔棋回滚');
test('makeMove/undoMove 完全回滚（棋盘、回合、计数、结果）', () => {
  const g = new Game({}, { rng: E.mulberry32(7) });
  const snap0 = JSON.stringify(g.serialize());
  const snaps = [];
  for (let i = 0; i < 40 && !g.result; i++) {
    snaps.push(JSON.stringify(g.serialize()));
    const m = g.legalMoves();
    const mv = m[(i * 7) % m.length];
    g.makeMove(mv >> 8, mv & 255);
  }
  while (g.history.length) {
    g.undoMove();
    assert.strictEqual(JSON.stringify(g.serialize()), snaps[g.history.length]);
  }
  assert.strictEqual(JSON.stringify(g.serialize()), snap0);
  assert.strictEqual(g.undoMove(), null);
});
test('悔棋撤销胜利结果', () => {
  const g = make([[0, 0], [0, 1], [0, 2], [0, 3], [1, 4]], filler);
  g.makeMove(P(1, 4), P(0, 4));
  assert.ok(g.result);
  g.undoMove();
  assert.strictEqual(g.result, null);
  assert.strictEqual(g.current, RED);
  assert.strictEqual(g.grid[P(1, 4)], RED);
});

console.log('三连计数去重');
test('同一三连只计 1 次；4 连计为 1 个', () => {
  const grid = new Uint8Array(100);
  [P(0, 0), P(0, 1), P(0, 2)].forEach(p => grid[p] = RED);
  assert.strictEqual(E.countRuns(grid, 10, RED).triples, 1);
  grid[P(0, 3)] = RED;
  const r = E.countRuns(grid, 10, RED);
  assert.strictEqual(r.triples, 1); assert.strictEqual(r.maxRun, 4);
  grid[P(1, 0)] = RED; grid[P(2, 0)] = RED; // 竖向三连共享 (0,0)
  assert.strictEqual(E.countRuns(grid, 10, RED).triples, 2);
});

console.log('开局约束');
test('500 个随机种子开局全部满足约束（无 4/5、三连≤3、差≤1、机动差≤2、无一步/两步必胜）', () => {
  const methods = {};
  for (let seed = 1; seed <= 500; seed++) {
    const L = E.generateLayout({}, E.mulberry32(seed));
    methods[L.method] = (methods[L.method] || 0) + 1;
    const g = L.grid;
    let red = 0, blue = 0; g.forEach(v => { if (v === RED) red++; if (v === BLUE) blue++; });
    assert.strictEqual(red, 15); assert.strictEqual(blue, 15);
    const r = E.countRuns(g, 10, RED), b = E.countRuns(g, 10, BLUE);
    assert.ok(r.maxRun <= 3 && b.maxRun <= 3, '无 4/5 连');
    assert.ok(r.triples <= 3 && b.triples <= 3, '单方三连≤3');
    assert.ok(Math.abs(r.triples - b.triples) <= 1, '三连差≤1');
    assert.ok(Math.abs(E.mobilityOf(g, 10, RED, false) - E.mobilityOf(g, 10, BLUE, false)) <= 2, '机动差≤2');
    assert.strictEqual(E.immediateWinsOf(g, 10, RED, false).length + E.immediateWinsOf(g, 10, BLUE, false).length, 0);
  }
  console.log('    开局方式分布', methods);
});
test('对称开局：蓝方 = 红方水平翻转', () => {
  const L = E.generateLayout({}, E.mulberry32(42));
  assert.strictEqual(L.method, 'symmetric');
  for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) {
    if (L.grid[P(r, c)] === RED) assert.strictEqual(L.grid[P(r, 9 - c)], BLUE);
  }
});
test('约束无法满足时有限重试 + 兜底（不死循环、不崩溃）', () => {
  const t = Date.now();
  const L = E.generateLayout({ maxTriplesPerSide: -1, layoutRetries: 50 }, E.mulberry32(3));
  assert.strictEqual(L.method, 'fallback');
  assert.ok(L.grid && L.attempts === 100);
  assert.ok(Date.now() - t < 5000);
  // 棋盘装不下对称布局时退化为独立随机
  const L2 = E.generateLayout({ size: 7, stones: 15, layoutRetries: 20, forbidForcedWin: false }, E.mulberry32(5));
  assert.ok(L2.grid.length === 49);
});
test('固定种子开局可复现（每日挑战）', () => {
  const a = E.generateLayout({}, E.mulberry32(E.hashString('2026-10-11')));
  const b = E.generateLayout({}, E.mulberry32(E.hashString('2026-10-11')));
  assert.deepStrictEqual(Array.from(a.grid), Array.from(b.grid));
});

console.log('加速模式');
// 两方各一颗棋子来回走动 → 永远不成三连
function shuttleGame() {
  return make([[0, 0], [5, 5]], [[9, 9], [7, 2]]);
}
function shuttle(g, n) {
  for (let i = 0; i < n; i++) {
    const p = g.current, src = p === RED ? [P(5, 5), P(5, 6)] : [P(7, 2), P(7, 3)];
    const from = g.grid[src[0]] === p ? src[0] : src[1];
    g.makeMove(from, from === src[0] ? src[1] : src[0]);
  }
}
test('连续 12 回合无三连 → 触发 8 回合加速，倒计时递减，到期复位', () => {
  const g = shuttleGame();
  shuttle(g, 11);
  assert.strictEqual(g.boostLeft, 0); assert.strictEqual(g.streak, 11);
  shuttle(g, 1);
  assert.strictEqual(g.boostLeft, 8, '第 12 回合后进入加速');
  assert.strictEqual(g.history[g.history.length - 1].boostStarted, true);
  for (let k = 7; k >= 0; k--) { shuttle(g, 1); assert.strictEqual(g.boostLeft, k); assert.ok(g.history[g.history.length - 1].boosted); }
  assert.strictEqual(g.history[g.history.length - 1].boostEnded, true);
  assert.strictEqual(g.streak, 0);
  shuttle(g, 1); assert.ok(!g.history[g.history.length - 1].boosted, '到期后恢复 1 格');
});
test('加速期间出现三连 → 立即复位；悔棋可恢复加速状态', () => {
  const g = make([[0, 0], [0, 1], [1, 3], [5, 5]], [[9, 9], [7, 2]]);
  shuttle(g, 12);
  assert.strictEqual(g.boostLeft, 8);
  assert.strictEqual(g.current, RED);
  g.makeMove(P(1, 3), P(0, 3)); // (0,3) 与 (0,0)(0,1) 不相连，未成三连
  assert.strictEqual(g.boostLeft, 7);
  shuttle(g, 1); // 蓝
  g.makeMove(P(0, 3), P(0, 2)); // 红成三连 (0,0)(0,1)(0,2)
  assert.ok(g.history[g.history.length - 1].formedTriple);
  assert.strictEqual(g.boostLeft, 0); assert.strictEqual(g.streak, 0); assert.strictEqual(g.noProgress, 0);
  g.undoMove();
  assert.strictEqual(g.boostLeft, 6);
});

console.log('和棋 / 回合上限');
test('连续 30 回合无新增三连 → 可申请和棋', () => {
  const g = shuttleGame();
  shuttle(g, 29); assert.ok(!g.canOfferDraw()); assert.ok(!g.agreeDraw());
  shuttle(g, 1); assert.ok(g.canOfferDraw());
  assert.ok(g.agreeDraw()); assert.strictEqual(g.result.winner, 0);
});
test('240 回合上限 → 按最大连子、再按机动性评分；同分判和', () => {
  let g = shuttleGame();
  shuttle(g, 239); assert.strictEqual(g.result, null);
  shuttle(g, 1);
  assert.strictEqual(g.result.reason, 'cap');
  // 双方都是 1 连；机动性：比较
  const a = g.capScore(RED), b = g.capScore(BLUE);
  const exp = a.mobility === b.mobility ? 0 : (a.mobility > b.mobility ? RED : BLUE);
  assert.strictEqual(g.result.winner, exp);
  // 构造最大连子不同的局面
  g = make([[0, 0], [0, 1], [5, 5]], [[9, 9], [7, 2]], { cfg: { turnCap: 2 } });
  shuttle(g, 2);
  assert.strictEqual(g.result.reason, 'cap'); assert.strictEqual(g.result.winner, RED);
  // 最大连子与机动性都相同 → 和（winner = 0）
  g = make([[0, 0], [5, 5]], [[9, 9], [7, 2]], { cfg: { turnCap: 1 } });
  g.makeMove(P(0, 0), P(0, 1)); // 红：(0,1) 3 步 + (5,5) 4 步 = 7；蓝：(9,9) 2 + (7,2) 4 = 6
  assert.strictEqual(g.result.winner, RED);
  g = make([[0, 1], [5, 5]], [[9, 9], [7, 2]], { cfg: { turnCap: 1 } });
  g.makeMove(P(0, 1), P(0, 0)); // 红：2 + 4 = 6；蓝：6 → 同分
  assert.strictEqual(g.result.reason, 'cap'); assert.strictEqual(g.result.winner, 0);
});
test('认输', () => {
  const g = new Game({}, { rng: E.mulberry32(1) });
  assert.ok(g.resign(RED)); assert.strictEqual(g.result.winner, BLUE);
});

console.log('提示');
test('防守提示：标出对方可成 4 的落点', () => {
  const g = make([[9, 0]], [[0, 0], [0, 1], [0, 2], [1, 3], [5, 5]]);
  const h = g.defenseHints(RED);
  assert.ok(h.some(x => x.to === P(0, 3) && x.len >= 4));
});
test('进攻提示：找到成五', () => {
  const g = make([[0, 0], [0, 1], [0, 2], [0, 3], [1, 4]], filler);
  const h = g.attackHint(RED);
  assert.strictEqual(h.to, P(0, 4)); assert.strictEqual(h.len, 5);
});

console.log('AI');
test('AI 模拟后棋盘无残留（三档、含加速状态、含超时中断）', () => {
  for (const level of ['easy', 'medium', 'hard']) {
    for (let seed = 1; seed <= 5; seed++) {
      const g = new Game({}, { rng: E.mulberry32(seed) });
      if (seed % 2) g.boostLeft = 4;
      const before = JSON.stringify(g.serialize());
      const r = AI.chooseMove(g, { level, timeBudget: seed === 5 ? 1 : 300, rng: E.mulberry32(seed) });
      assert.strictEqual(JSON.stringify(g.serialize()), before, level + ' 残留');
      assert.ok(g.isLegal(r.from, r.to), level + ' 返回非法走法');
    }
  }
});
test('AI 能一步成五', () => {
  const g = make([[0, 0], [0, 1], [0, 2], [0, 3], [1, 4], [5, 5]], filler);
  for (const level of ['medium', 'hard']) {
    const r = AI.chooseMove(g, { level, timeBudget: 500 });
    assert.deepStrictEqual([r.from, r.to], [P(1, 4), P(0, 4)], level);
  }
});
test('AI 会封堵对方成五威胁（中级/高级）', () => {
  // 蓝方 (0,0..3) 四连且 (1,4) 可上移成五；红方唯一的封堵是 (0,5) 左移到 (0,4)
  const g = make([[0, 5], [6, 6], [6, 8]], [[0, 0], [0, 1], [0, 2], [0, 3], [1, 4], [9, 9]]);
  for (const level of ['medium', 'hard']) {
    const r = AI.chooseMove(g, { level, timeBudget: 500 });
    assert.strictEqual(r.to, P(0, 4), level + ' 未封堵');
  }
});
test('深度真正分档：高级比中级搜索节点更多', () => {
  const g = new Game({}, { rng: E.mulberry32(11) });
  const m = AI.chooseMove(g, { level: 'medium', timeBudget: 2000 });
  const h = AI.chooseMove(g, { level: 'hard', timeBudget: 2000 });
  assert.strictEqual(m.depth, 2); assert.strictEqual(h.depth, 3);
  assert.ok(h.nodes > m.nodes);
});
test('Game.fromState 序列化往返一致', () => {
  const g = new Game({}, { rng: E.mulberry32(9) });
  g.boostLeft = 3; g.streak = 0; g.noProgress = 7;
  const g2 = Game.fromState(JSON.parse(JSON.stringify(g.serialize())));
  const a = g.serialize(), b = g2.serialize(); delete a.historyLength; delete b.historyLength;
  assert.deepStrictEqual(a, b);
});

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
