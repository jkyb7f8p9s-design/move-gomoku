/* 移动五子棋 · AI（极小极大 + alpha-beta，迭代加深 + 时间预算，make/undo 安全模拟） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.MGAI = factory(root.MGEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';
  var WIN = 1000000;
  var ABORT = { abort: true };
  // 窗口内己方子数 → 棋型分（眠一 < 活二 < 眠三/活三 < 冲四 ...）
  var LEVELS = {
    easy:   { name: '初级', depth: 1, W: [0, 1, 5, 30, 200], defW: 1.0, mobW: 1, tieEps: 0, jitter: 0, randomPick: 0.7 },
    medium: { name: '中级', depth: 2, W: [0, 1, 8, 50, 400], defW: 1.15, mobW: 3, tieEps: 3, jitter: 0 },
    hard:   { name: '高级', depth: 3, W: [0, 2, 10, 70, 600], defW: 1.35, mobW: 4, tieEps: 2, jitter: 4 }
  };

  function makeEvaluator(level) {
    var W = level.W, defW = level.defW, mobW = level.mobW;
    var markS = null, markO = null, stamp = 0;
    return function evaluate(game, side) {
      var g = game.grid, size = game.size, G = E.geo(size), N = G.N, wins = G.windows, wc = G.windowCount;
      var nb = G.nb, nb2 = G.nb2, boost = game.boostLeft > 0, opp = 3 - side;
      if (!markS || markS.length !== N) { markS = new Int32Array(N); markO = new Int32Array(N); }
      stamp++;
      var sS = 0, sO = 0, thS = 0, thO = 0, oThreatCell = -1;
      for (var w = 0; w < wc; w++) {
        var base = w * 5, cS = 0, cO = 0, empty = -1;
        for (var i = 0; i < 5; i++) {
          var v = g[wins[base + i]];
          if (v === side) cS++; else if (v === opp) cO++; else empty = wins[base + i];
        }
        if (cS && cO) continue;
        if (cS) {
          sS += W[cS] || 0;
          if (cS === 4 && markS[empty] !== stamp && fillable(g, nb, nb2, wins, base, empty, side, boost)) { markS[empty] = stamp; thS++; }
        } else if (cO) {
          sO += W[cO] || 0;
          if (cO === 4 && markO[empty] !== stamp && fillable(g, nb, nb2, wins, base, empty, opp, boost)) { markO[empty] = stamp; thO++; oThreatCell = empty; }
        }
      }
      // 空间分：可移动步数（被堵死的棋子价值趋近 0）
      var mS = 0, mO = 0;
      for (var p = 0; p < N; p++) {
        var s = g[p]; if (!s) continue;
        var m = 0;
        for (var d = 0; d < 4; d++) { var q = nb[p * 4 + d]; if (q >= 0 && g[q] === 0) m++; }
        if (s === side) mS += m; else mO += m;
      }
      var score = sS - defW * sO + mobW * (mS - mO);
      if (thS > 0) return 90000 + score;                // 轮到我且下一步可成五
      if (thO >= 2) return -80000 + score;              // 对方双威胁，挡不住
      if (thO === 1) {                                   // 必须封堵
        var canBlock = false;
        for (var dd = 0; dd < 4 && !canBlock; dd++) {
          var a = nb[oThreatCell * 4 + dd];
          if (a >= 0 && g[a] === side) canBlock = true;
          else if (boost && a >= 0 && g[a] === 0) { var b2 = nb2[oThreatCell * 4 + dd]; if (b2 >= 0 && g[b2] === side) canBlock = true; }
        }
        score += canBlock ? -1500 : -80000;
      }
      return score;
    };
  }
  function fillable(g, nb, nb2, wins, base, e, player, boost) {
    for (var d = 0; d < 4; d++) {
      var a = nb[e * 4 + d];
      if (a < 0) continue;
      if (g[a] === player && !inWindow(wins, base, a)) return true;
      if (boost && g[a] === 0) { var b = nb2[e * 4 + d]; if (b >= 0 && g[b] === player && !inWindow(wins, base, b)) return true; }
    }
    return false;
  }
  function inWindow(wins, base, p) {
    return wins[base] === p || wins[base + 1] === p || wins[base + 2] === p || wins[base + 3] === p || wins[base + 4] === p;
  }

  // 走法排序启发：落点成连 + 封堵对方连线
  function orderMoves(game, moves, player) {
    var g = game.grid, size = game.size, opp = 3 - player, scored = [];
    for (var i = 0; i < moves.length; i++) {
      var f = moves[i] >> 8, t = moves[i] & 255, h = 0;
      g[f] = 0;
      try {
        for (var k = 0; k < 4; k++) {
          g[t] = player; var own = E.runLength(g, size, t, player, k);
          g[t] = opp; var blk = E.runLength(g, size, t, opp, k);
          g[t] = 0;
          h += own * own * 10 + blk * blk * 9;
        }
      } finally { g[t] = 0; g[f] = player; }
      scored.push([moves[i], h]);
    }
    scored.sort(function (a, b) { return b[1] - a[1]; });
    for (var j = 0; j < scored.length; j++) moves[j] = scored[j][0];
    return moves;
  }

  function terminalScore(game, ply) {
    var r = game.result;
    if (r.winner === 0) return 0;
    return r.winner === game.current ? WIN - ply : -(WIN - ply);
  }

  /**
   * 选择走法。opts: { level:'easy'|'medium'|'hard', timeBudget(ms), rng, maxDepth }
   * 返回 { from, to, score, depth, nodes, timedOut }
   */
  function chooseMove(game, opts) {
    opts = opts || {};
    var level = LEVELS[opts.level] || LEVELS.medium;
    var rng = opts.rng || Math.random;
    var budget = opts.timeBudget == null ? 1200 : opts.timeBudget;
    var maxDepth = opts.maxDepth || level.depth;
    var deadline = Date.now() + budget;
    var evaluate = makeEvaluator(level);
    var me = game.current, nodes = 0;
    if (game.result) return null;
    var rootMoves = game.legalMoves(me);
    if (!rootMoves.length) return null;
    orderMoves(game, rootMoves, me);
    var startHistory = game.history.length;

    function negamax(depth, alpha, beta, ply) {
      if ((++nodes & 255) === 0 && Date.now() > deadline) throw ABORT;
      if (game.result) return terminalScore(game, ply);
      if (depth === 0) return evaluate(game, game.current);
      var moves = orderMoves(game, game.legalMoves(game.current), game.current);
      var best = -Infinity;
      for (var i = 0; i < moves.length; i++) {
        game.makeMove(moves[i] >> 8, moves[i] & 255);
        var v;
        try { v = -negamax(depth - 1, -beta, -alpha, ply + 1); }
        finally { game.undoMove(); }
        if (v > best) best = v;
        if (v > alpha) alpha = v;
        if (alpha >= beta) break;
      }
      return best;
    }

    function searchRoot(depth, eps) {
      var scores = [], bestV = -Infinity;
      for (var i = 0; i < rootMoves.length; i++) {
        var m = rootMoves[i], v;
        game.makeMove(m >> 8, m & 255);
        try {
          var alpha = bestV === -Infinity ? -Infinity : bestV - eps - 1;
          v = -negamax(depth - 1, -Infinity, -alpha, 1);
        } finally { game.undoMove(); }
        scores.push([m, v]);
        if (v > bestV) bestV = v;
      }
      return scores;
    }

    var result = null, timedOut = false, completedDepth = 0, lastScores = null;
    try {
      for (var d = 1; d <= maxDepth; d++) {
        var sc = searchRoot(d, level.tieEps);
        lastScores = sc; completedDepth = d;
        // 下一层按本层得分排序（提升剪枝效率）
        sc.slice().sort(function (a, b) { return b[1] - a[1]; }).forEach(function (x, i) { rootMoves[i] = x[0]; });
        var top = Math.max.apply(null, sc.map(function (x) { return x[1]; }));
        if (top >= WIN - 10) break; // 已找到必胜
      }
    } catch (e) {
      if (e !== ABORT) throw e;
      timedOut = true;
    }
    if (game.history.length !== startHistory) throw new Error('AI 状态残留');

    if (!lastScores) { // 连 1 层都没算完：取启发排序第一
      var m0 = rootMoves[0];
      return { from: m0 >> 8, to: m0 & 255, score: 0, depth: 0, nodes: nodes, timedOut: true };
    }
    var pick;
    if (level.randomPick) {
      // 初级：随机 + 轻微"不主动送死"（避开让对方立即成五/挡不住的走法）；有必胜则大概率拿下
      var winning = lastScores.filter(function (x) { return x[1] >= WIN - 10; });
      if (winning.length && rng() < 0.6) pick = winning[0];
      else {
        var safe = lastScores.filter(function (x) { return x[1] > -30000; });
        if (!safe.length) safe = lastScores;
        if (rng() < level.randomPick) pick = safe[(rng() * safe.length) | 0];
        else pick = safe.reduce(function (a, b) { return b[1] > a[1] ? b : a; });
      }
    } else {
      var jit = level.jitter;
      var adj = lastScores.map(function (x) { return [x[0], x[1] + (jit && Math.abs(x[1]) < 30000 ? rng() * jit : 0)]; });
      var bestV = Math.max.apply(null, adj.map(function (x) { return x[1]; }));
      var ties = adj.filter(function (x) { return x[1] >= bestV - level.tieEps; });
      pick = ties[(rng() * ties.length) | 0];   // 同分随机
    }
    var raw = lastScores.filter(function (x) { return x[0] === pick[0]; })[0][1];
    return { from: pick[0] >> 8, to: pick[0] & 255, score: raw, depth: completedDepth, nodes: nodes, timedOut: timedOut };
  }

  /** 从 side 视角的静态局面评估（供和棋决策等使用） */
  function evaluatePosition(game, side, levelKey) {
    return makeEvaluator(LEVELS[levelKey] || LEVELS.medium)(game, side);
  }

  return { chooseMove: chooseMove, evaluatePosition: evaluatePosition, LEVELS: LEVELS, WIN: WIN };
});
