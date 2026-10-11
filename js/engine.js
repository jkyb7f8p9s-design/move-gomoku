/* 移动五子棋 · 纯逻辑模型层（Board / 规则 / 开局 / 加速 / 和棋 / 悔棋 / 提示）
 * 不依赖 DOM，可在浏览器、Web Worker 与 Node 中运行。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MGEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_CONFIG = {
    size: 10,             // 棋盘边长
    stones: 15,           // 每方棋子数
    boostTrigger: 12,     // 连续无三连回合数 → 触发加速
    boostDuration: 8,     // 加速持续回合数
    turnCap: 240,         // 总回合上限
    noProgressLimit: 30,  // 无进展回合 → 可和棋
    undoPerSide: 3,
    hintPerSide: 2,
    maxTriplesPerSide: 3,
    maxTripleDiff: 1,
    maxMobilityDiff: 2,
    layoutRetries: 300,
    winLength: 5
  };

  var EMPTY = 0, RED = 1, BLUE = 2;
  var LINE_DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
  var ORTHO = [[0, 1], [0, -1], [1, 0], [-1, 0]];

  function other(p) { return 3 - p; }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashString(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h;
  }

  // ---------- 几何缓存 ----------
  var geoCache = {};
  function geo(size) {
    if (geoCache[size]) return geoCache[size];
    var N = size * size;
    var nb = new Int16Array(N * 4);       // 正交邻居
    var nb2 = new Int16Array(N * 4);      // 正交两格
    for (var p = 0; p < N; p++) {
      var r = (p / size) | 0, c = p % size;
      for (var d = 0; d < 4; d++) {
        var r1 = r + ORTHO[d][0], c1 = c + ORTHO[d][1];
        var r2 = r + 2 * ORTHO[d][0], c2 = c + 2 * ORTHO[d][1];
        nb[p * 4 + d] = (r1 >= 0 && r1 < size && c1 >= 0 && c1 < size) ? r1 * size + c1 : -1;
        nb2[p * 4 + d] = (r2 >= 0 && r2 < size && c2 >= 0 && c2 < size) ? r2 * size + c2 : -1;
      }
    }
    // 所有长度为 5 的窗口（供 AI 评估）
    var wins = [];
    for (var r0 = 0; r0 < size; r0++) for (var c0 = 0; c0 < size; c0++) {
      for (var k = 0; k < 4; k++) {
        var dr = LINE_DIRS[k][0], dc = LINE_DIRS[k][1];
        var re = r0 + 4 * dr, ce = c0 + 4 * dc;
        if (re < 0 || re >= size || ce < 0 || ce >= size) continue;
        for (var i = 0; i < 5; i++) wins.push((r0 + i * dr) * size + (c0 + i * dc));
      }
    }
    var g = { size: size, N: N, nb: nb, nb2: nb2, windows: new Int16Array(wins), windowCount: wins.length / 5 };
    geoCache[size] = g;
    return g;
  }

  // ---------- 纯函数工具（作用于 grid） ----------
  function runLength(grid, size, pos, player, k) {
    var dr = LINE_DIRS[k][0], dc = LINE_DIRS[k][1];
    var r = (pos / size) | 0, c = pos % size, n = 1, rr, cc;
    rr = r + dr; cc = c + dc;
    while (rr >= 0 && rr < size && cc >= 0 && cc < size && grid[rr * size + cc] === player) { n++; rr += dr; cc += dc; }
    rr = r - dr; cc = c - dc;
    while (rr >= 0 && rr < size && cc >= 0 && cc < size && grid[rr * size + cc] === player) { n++; rr -= dr; cc -= dc; }
    return n;
  }
  function maxRunAt(grid, size, pos, player) {
    var m = 0;
    for (var k = 0; k < 4; k++) { var l = runLength(grid, size, pos, player, k); if (l > m) m = l; }
    return m;
  }
  /** 显式胜利判定：返回连线格子数组（≥5）或 null */
  function checkWinAt(grid, size, pos, player, winLength) {
    winLength = winLength || 5;
    if (grid[pos] !== player) return null;
    var r = (pos / size) | 0, c = pos % size;
    for (var k = 0; k < 4; k++) {
      var dr = LINE_DIRS[k][0], dc = LINE_DIRS[k][1];
      var cells = [pos], rr, cc;
      rr = r - dr; cc = c - dc;
      while (rr >= 0 && rr < size && cc >= 0 && cc < size && grid[rr * size + cc] === player) { cells.unshift(rr * size + cc); rr -= dr; cc -= dc; }
      rr = r + dr; cc = c + dc;
      while (rr >= 0 && rr < size && cc >= 0 && cc < size && grid[rr * size + cc] === player) { cells.push(rr * size + cc); rr += dr; cc += dc; }
      if (cells.length >= winLength) return cells;
    }
    return null;
  }
  /** 统计某方所有极大连（去重：只从连的起点计数） */
  function countRuns(grid, size, player) {
    var triples = 0, maxRun = 0, fours = 0;
    for (var p = 0; p < size * size; p++) {
      if (grid[p] !== player) continue;
      var r = (p / size) | 0, c = p % size;
      for (var k = 0; k < 4; k++) {
        var dr = LINE_DIRS[k][0], dc = LINE_DIRS[k][1];
        var pr = r - dr, pc = c - dc;
        if (pr >= 0 && pr < size && pc >= 0 && pc < size && grid[pr * size + pc] === player) continue; // 非起点
        var n = 1, rr = r + dr, cc = c + dc;
        while (rr >= 0 && rr < size && cc >= 0 && cc < size && grid[rr * size + cc] === player) { n++; rr += dr; cc += dc; }
        if (n > maxRun) maxRun = n;
        if (n >= 3) triples++;
        if (n >= 4) fours++;
      }
    }
    return { triples: triples, maxRun: maxRun, fours: fours };
  }
  function liveThreeAt(grid, size, pos, player) {
    var r = (pos / size) | 0, c = pos % size;
    for (var k = 0; k < 4; k++) {
      var dr = LINE_DIRS[k][0], dc = LINE_DIRS[k][1];
      var a = 0, b = 0, rr, cc;
      rr = r + dr; cc = c + dc;
      while (rr >= 0 && rr < size && cc >= 0 && cc < size && grid[rr * size + cc] === player) { a++; rr += dr; cc += dc; }
      var endA = (rr >= 0 && rr < size && cc >= 0 && cc < size && grid[rr * size + cc] === EMPTY);
      rr = r - dr; cc = c - dc;
      while (rr >= 0 && rr < size && cc >= 0 && cc < size && grid[rr * size + cc] === player) { b++; rr -= dr; cc -= dc; }
      var endB = (rr >= 0 && rr < size && cc >= 0 && cc < size && grid[rr * size + cc] === EMPTY);
      if (a + b + 1 === 3 && endA && endB) return true;
    }
    return false;
  }
  function targetsFrom(grid, size, pos, boost, out) {
    var G = geo(size); out = out || [];
    for (var d = 0; d < 4; d++) {
      var p1 = G.nb[pos * 4 + d];
      if (p1 < 0 || grid[p1] !== EMPTY) continue; // 1 格被堵则 2 格路径也不通
      out.push(p1);
      if (boost) { var p2 = G.nb2[pos * 4 + d]; if (p2 >= 0 && grid[p2] === EMPTY) out.push(p2); }
    }
    return out;
  }
  function legalMovesOf(grid, size, player, boost) {
    var moves = [], tmp = [];
    for (var p = 0; p < size * size; p++) {
      if (grid[p] !== player) continue;
      tmp.length = 0; targetsFrom(grid, size, p, boost, tmp);
      for (var i = 0; i < tmp.length; i++) moves.push((p << 8) | tmp[i]);
    }
    return moves;
  }
  function mobilityOf(grid, size, player, boost) { return legalMovesOf(grid, size, player, boost).length; }
  function hasAnyMoveOf(grid, size, player) {
    var G = geo(size);
    for (var p = 0; p < size * size; p++) {
      if (grid[p] !== player) continue;
      for (var d = 0; d < 4; d++) { var q = G.nb[p * 4 + d]; if (q >= 0 && grid[q] === EMPTY) return true; }
    }
    return false; // 1 格不通则 2 格也不通，故 1 格检查即可
  }
  function immediateWinsOf(grid, size, player, boost, winLength) {
    var res = [], moves = legalMovesOf(grid, size, player, boost);
    for (var i = 0; i < moves.length; i++) {
      var f = moves[i] >> 8, t = moves[i] & 255;
      grid[f] = EMPTY; grid[t] = player;
      try { if (checkWinAt(grid, size, t, player, winLength)) res.push(moves[i]); }
      finally { grid[t] = EMPTY; grid[f] = player; }
    }
    return res;
  }

  // ---------- 公平开局 ----------
  function evaluateLayout(grid, cfg) {
    var s = cfg.size;
    var r = countRuns(grid, s, RED), b = countRuns(grid, s, BLUE);
    var mr = mobilityOf(grid, s, RED, false), mb = mobilityOf(grid, s, BLUE, false);
    var wr = immediateWinsOf(grid, s, RED, false, cfg.winLength).length;
    var wb = immediateWinsOf(grid, s, BLUE, false, cfg.winLength).length;
    var v = 0;
    v += Math.max(0, r.maxRun - 3) * 10 + Math.max(0, b.maxRun - 3) * 10;
    v += Math.max(0, r.triples - cfg.maxTriplesPerSide) * 3 + Math.max(0, b.triples - cfg.maxTriplesPerSide) * 3;
    v += Math.max(0, Math.abs(r.triples - b.triples) - cfg.maxTripleDiff) * 3;
    v += Math.max(0, Math.abs(mr - mb) - cfg.maxMobilityDiff);
    v += (wr + wb) * 10;            // 无"开局即可一步成五"的必胜形
    if (v === 0 && cfg.forbidForcedWin !== false) {   // 无"两步强制成五"的必胜形
      if (hasForcedWin3(grid, s, RED, cfg.winLength) || hasForcedWin3(grid, s, BLUE, cfg.winLength)) v += 5;
    }
    if (mr === 0 || mb === 0) v += 50;
    return { violations: v, ok: v === 0, redTriples: r.triples, blueTriples: b.triples, redMax: r.maxRun, blueMax: b.maxRun, redMobility: mr, blueMobility: mb };
  }
  /** player 先走时，是否存在"我走一步后，对方任意应对，我都能一步成五"的强制胜 */
  function hasForcedWin3(grid, size, player, winLength) {
    var opp = other(player), m1 = legalMovesOf(grid, size, player, false);
    for (var i = 0; i < m1.length; i++) {
      var f = m1[i] >> 8, t = m1[i] & 255, forced = false;
      grid[f] = EMPTY; grid[t] = player;
      try {
        if (checkWinAt(grid, size, t, player, winLength)) forced = true;
        else if (immediateWinsOf(grid, size, player, false, winLength).length) {
          forced = true;
          var m2 = legalMovesOf(grid, size, opp, false);
          for (var j = 0; j < m2.length && forced; j++) {
            var f2 = m2[j] >> 8, t2 = m2[j] & 255;
            grid[f2] = EMPTY; grid[t2] = opp;
            try { if (!immediateWinsOf(grid, size, player, false, winLength).length) forced = false; }
            finally { grid[t2] = EMPTY; grid[f2] = opp; }
          }
        }
      } finally { grid[t] = EMPTY; grid[f] = player; }
      if (forced) return true;
    }
    return false;
  }
  function shuffle(arr, rng) {
    for (var i = arr.length - 1; i > 0; i--) { var j = (rng() * (i + 1)) | 0; var t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
    return arr;
  }
  function symmetricCandidate(cfg, rng) {
    var s = cfg.size, half = Math.floor(s / 2), pairs = [];
    for (var r = 0; r < s; r++) for (var c = 0; c < half; c++) pairs.push([r * s + c, r * s + (s - 1 - c)]);
    if (pairs.length < cfg.stones) return null;
    shuffle(pairs, rng);
    var grid = new Uint8Array(s * s);
    for (var i = 0; i < cfg.stones; i++) {
      var flip = rng() < 0.5, a = pairs[i][flip ? 1 : 0], b = pairs[i][flip ? 0 : 1];
      grid[a] = RED; grid[b] = BLUE; // 蓝方 = 红方水平翻转
    }
    return grid;
  }
  function randomCandidate(cfg, rng) {
    var s = cfg.size, cells = [];
    for (var i = 0; i < s * s; i++) cells.push(i);
    shuffle(cells, rng);
    var grid = new Uint8Array(s * s);
    for (var k = 0; k < cfg.stones * 2 && k < cells.length; k++) grid[cells[k]] = k < cfg.stones ? RED : BLUE;
    return grid;
  }
  /** 生成开局：对称优先 → 独立随机 → 有限重试后取最优（兜底，不会死循环） */
  function generateLayout(cfg, rng) {
    cfg = Object.assign({}, DEFAULT_CONFIG, cfg || {}); rng = rng || Math.random;
    var best = null, bestEval = null, attempts = 0, i, g, e;
    for (i = 0; i < cfg.layoutRetries; i++) {
      attempts++; g = symmetricCandidate(cfg, rng); if (!g) break;
      e = evaluateLayout(g, cfg);
      if (e.ok) return { grid: g, method: 'symmetric', attempts: attempts, eval: e };
      if (!bestEval || e.violations < bestEval.violations) { best = g; bestEval = e; }
    }
    for (i = 0; i < cfg.layoutRetries; i++) {
      attempts++; g = randomCandidate(cfg, rng); e = evaluateLayout(g, cfg);
      if (e.ok) return { grid: g, method: 'random', attempts: attempts, eval: e };
      if (!bestEval || e.violations < bestEval.violations) { best = g; bestEval = e; }
    }
    return { grid: best, method: 'fallback', attempts: attempts, eval: bestEval };
  }

  // ---------- Game ----------
  function Game(config, opts) {
    opts = opts || {};
    this.cfg = Object.assign({}, DEFAULT_CONFIG, config || {});
    this.size = this.cfg.size;
    this.N = this.size * this.size;
    this.rng = opts.rng || Math.random;
    this.grid = new Uint8Array(this.N);
    if (opts.grid) { this.grid.set(opts.grid); this.layoutInfo = { method: 'given' }; }
    else {
      var lay = generateLayout(this.cfg, this.rng);
      this.grid.set(lay.grid);
      this.layoutInfo = { method: lay.method, attempts: lay.attempts, eval: lay.eval };
    }
    this.current = opts.first === BLUE ? BLUE : RED;
    this.firstPlayer = this.current;
    this.turn = 0;          // 已走回合数
    this.streak = 0;        // 连续无三连回合
    this.boostLeft = 0;     // 加速剩余回合
    this.noProgress = 0;    // 连续无新增三连回合
    this.history = [];
    this.result = null;
  }
  Game.prototype.isBoost = function () { return this.boostLeft > 0; };
  Game.prototype.rc = function (pos) { return [(pos / this.size) | 0, pos % this.size]; };
  Game.prototype.targets = function (pos) {
    if (this.grid[pos] === EMPTY) return [];
    return targetsFrom(this.grid, this.size, pos, this.isBoost());
  };
  Game.prototype.legalMoves = function (player) {
    return legalMovesOf(this.grid, this.size, player || this.current, this.isBoost());
  };
  Game.prototype.hasAnyMove = function (player) { return hasAnyMoveOf(this.grid, this.size, player); };
  Game.prototype.mobility = function (player, boost) { return mobilityOf(this.grid, this.size, player, !!boost); };
  Game.prototype.isLegal = function (from, to) { return this.explainIllegal(from, to) === null; };
  /** 返回非法原因（中文）；合法则 null */
  Game.prototype.explainIllegal = function (from, to, player) {
    player = player || this.current;
    if (this.result) return '对局已结束';
    if (from < 0 || from >= this.N || to < 0 || to >= this.N) return '超出棋盘';
    if (this.grid[from] !== player) return '只能移动己方棋子';
    if (from === to) return '请选择目标格';
    if (this.grid[to] !== EMPTY) return '目标格已有棋子';
    var fr = (from / this.size) | 0, fc = from % this.size, tr = (to / this.size) | 0, tc = to % this.size;
    if (fr !== tr && fc !== tc) return '只能横向或纵向移动';
    var dist = Math.abs(fr - tr) + Math.abs(fc - tc);
    var maxD = this.isBoost() ? 2 : 1;
    if (dist > maxD) return this.isBoost() ? '加速模式最多移动 2 格' : '普通回合只能移动 1 格';
    if (dist === 2) {
      var mid = ((fr + tr) / 2) * this.size + (fc + tc) / 2;
      if (this.grid[mid] !== EMPTY) return '路径被阻挡';
    }
    return null;
  };
  Game.prototype.checkWin = function (pos, player) { return checkWinAt(this.grid, this.size, pos, player, this.cfg.winLength); };
  Game.prototype.check_win = Game.prototype.checkWin;
  Game.prototype.formsTriple = function (pos, player) { return maxRunAt(this.grid, this.size, pos, player) >= 3; };

  Game.prototype.makeMove = function (from, to) {
    var why = this.explainIllegal(from, to);
    if (why) throw new Error('非法移动: ' + why);
    var mover = this.current, cfg = this.cfg;
    var entry = {
      from: from, to: to, player: mover, boosted: this.boostLeft > 0,
      prev: { streak: this.streak, boostLeft: this.boostLeft, noProgress: this.noProgress, result: this.result, turn: this.turn },
      formedTriple: false, boostStarted: false, boostEnded: false
    };
    this.grid[from] = EMPTY; this.grid[to] = mover;
    var formed = maxRunAt(this.grid, this.size, to, mover) >= 3;
    entry.formedTriple = formed;
    if (formed) {
      if (this.boostLeft > 0) entry.boostEnded = true;
      this.streak = 0; this.boostLeft = 0; this.noProgress = 0;
    } else {
      this.noProgress++;
      if (this.boostLeft > 0) {
        this.boostLeft--;
        if (this.boostLeft === 0) { this.streak = 0; entry.boostEnded = true; }
      } else {
        this.streak++;
        if (this.streak >= cfg.boostTrigger) { this.boostLeft = cfg.boostDuration; this.streak = 0; entry.boostStarted = true; }
      }
    }
    this.turn++;
    this.current = other(mover);
    var line = this.checkWin(to, mover);
    if (line) this.result = { winner: mover, reason: 'five', line: line };
    else if (!this.hasAnyMove(this.current)) this.result = { winner: mover, reason: 'blocked', loser: this.current };
    else if (this.turn >= cfg.turnCap) this.result = this.capResult();
    this.history.push(entry);
    return entry;
  };
  Game.prototype.undoMove = function () {
    var e = this.history.pop();
    if (!e) return null;
    this.grid[e.to] = EMPTY; this.grid[e.from] = e.player;
    this.streak = e.prev.streak; this.boostLeft = e.prev.boostLeft; this.noProgress = e.prev.noProgress;
    this.result = e.prev.result; this.turn = e.prev.turn; this.current = e.player;
    return e;
  };
  Game.prototype.capScore = function (player) {
    return { maxRun: countRuns(this.grid, this.size, player).maxRun, mobility: this.mobility(player, false) };
  };
  Game.prototype.capResult = function () {
    var a = this.capScore(RED), b = this.capScore(BLUE), w = 0;
    if (a.maxRun !== b.maxRun) w = a.maxRun > b.maxRun ? RED : BLUE;
    else if (a.mobility !== b.mobility) w = a.mobility > b.mobility ? RED : BLUE;
    return { winner: w, reason: 'cap', scores: { 1: a, 2: b } };
  };
  Game.prototype.canOfferDraw = function () { return !this.result && this.noProgress >= this.cfg.noProgressLimit; };
  Game.prototype.agreeDraw = function () {
    if (!this.canOfferDraw()) return false;
    this.result = { winner: 0, reason: 'agreed' }; return true;
  };
  Game.prototype.resign = function (player) {
    if (this.result) return false;
    this.result = { winner: other(player), reason: 'resign', loser: player }; return true;
  };
  Game.prototype.maxRun = function (player) { return countRuns(this.grid, this.size, player).maxRun; };
  Game.prototype.liveThreeAt = function (pos, player) { return liveThreeAt(this.grid, this.size, pos, player); };
  Game.prototype.maxRunAt = function (pos, player) { return maxRunAt(this.grid, this.size, pos, player); };

  /** 防守提示：对方下一步可成 4/5 的落点 */
  Game.prototype.defenseHints = function (player) {
    player = player || this.current;
    var opp = other(player), moves = legalMovesOf(this.grid, this.size, opp, this.isBoost()), res = [];
    for (var i = 0; i < moves.length; i++) {
      var f = moves[i] >> 8, t = moves[i] & 255;
      this.grid[f] = EMPTY; this.grid[t] = opp;
      try { var l = maxRunAt(this.grid, this.size, t, opp); if (l >= 4) res.push({ from: f, to: t, len: l }); }
      finally { this.grid[t] = EMPTY; this.grid[f] = opp; }
    }
    res.sort(function (a, b) { return b.len - a.len; });
    return res;
  };
  /** 进攻提示：己方下一步能成最大连子或活三的走法 */
  Game.prototype.attackHint = function (player) {
    player = player || this.current;
    var moves = legalMovesOf(this.grid, this.size, player, this.isBoost()), best = null;
    for (var i = 0; i < moves.length; i++) {
      var f = moves[i] >> 8, t = moves[i] & 255;
      var before = maxRunAt(this.grid, this.size, f, player);
      this.grid[f] = EMPTY; this.grid[t] = player;
      try {
        var l = maxRunAt(this.grid, this.size, t, player), live = liveThreeAt(this.grid, this.size, t, player);
        var sc = l * 100 + (live ? 60 : 0) - before * 10 + (l >= 5 ? 10000 : 0) + this.rng();
        if (!best || sc > best.score) best = { from: f, to: t, len: l, liveThree: live, score: sc };
      } finally { this.grid[t] = EMPTY; this.grid[f] = player; }
    }
    return best;
  };

  Game.prototype.serialize = function () {
    return {
      cfg: this.cfg, grid: Array.prototype.slice.call(this.grid), current: this.current, firstPlayer: this.firstPlayer,
      turn: this.turn, streak: this.streak, boostLeft: this.boostLeft, noProgress: this.noProgress,
      result: this.result ? JSON.parse(JSON.stringify(this.result)) : null, historyLength: this.history.length
    };
  };
  Game.fromState = function (s, opts) {
    var g = new Game(s.cfg, { grid: s.grid, first: s.current, rng: opts && opts.rng });
    g.firstPlayer = s.firstPlayer || s.current;
    g.turn = s.turn; g.streak = s.streak; g.boostLeft = s.boostLeft; g.noProgress = s.noProgress; g.result = s.result || null;
    return g;
  };
  Game.prototype.clone = function () { return Game.fromState(this.serialize()); };

  function posName(pos, size) {
    size = size || 10;
    return 'ABCDEFGHIJKLMNOP'[pos % size] + (((pos / size) | 0) + 1);
  }

  return {
    DEFAULT_CONFIG: DEFAULT_CONFIG, EMPTY: EMPTY, RED: RED, BLUE: BLUE, LINE_DIRS: LINE_DIRS, ORTHO: ORTHO,
    Game: Game, other: other, geo: geo, mulberry32: mulberry32, hashString: hashString,
    runLength: runLength, maxRunAt: maxRunAt, checkWinAt: checkWinAt, countRuns: countRuns, liveThreeAt: liveThreeAt,
    targetsFrom: targetsFrom, legalMovesOf: legalMovesOf, mobilityOf: mobilityOf, hasAnyMoveOf: hasAnyMoveOf,
    immediateWinsOf: immediateWinsOf, hasForcedWin3: hasForcedWin3, evaluateLayout: evaluateLayout, generateLayout: generateLayout, posName: posName
  };
});
