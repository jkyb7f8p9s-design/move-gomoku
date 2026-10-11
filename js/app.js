/* 移动五子棋 · 控制器 + 渲染 + 存档 + 音效（与模型层分离） */
(function () {
  'use strict';
  var E = window.MGEngine, AIM = window.MGAI;
  var RED = E.RED, BLUE = E.BLUE;
  var $ = function (s) { return document.querySelector(s); };
  var SIDE_NAME = { 1: '红方', 2: '蓝方' };
  var DIFF = { easy: '初级', medium: '中级', hard: '高级' };
  var DIFF_COEF = { easy: 1, medium: 2, hard: 3 };
  var AI_BUDGET = 1200;          // AI 思考时间预算（ms）
  var DAILY_MOVE_LIMIT = 40;     // 每日挑战：40 手内取胜
  var SCHEMA_VERSION = 2;
  var TIERS = [
    { name: '青铜', min: 0, color: '#c98a52' }, { name: '白银', min: 60, color: '#c7d0dc' },
    { name: '黄金', min: 160, color: '#f5c542' }, { name: '铂金', min: 320, color: '#7fe0d0' },
    { name: '钻石', min: 560, color: '#8cb8ff' }, { name: '大师', min: 900, color: '#d58cff' }
  ];
  var ACHIEVEMENTS = [
    { id: 'first_win', icon: '🥇', name: '首胜', desc: '第一次战胜 AI' },
    { id: 'streak5', icon: '🔥', name: '五连胜', desc: '连续赢下 5 局' },
    { id: 'hard_win', icon: '🧠', name: '登峰造极', desc: '战胜高级 AI' },
    { id: 'double_three', icon: '✌️', name: '双活三', desc: '一局内走出 2 个活三' },
    { id: 'quick_win', icon: '⚡', name: '速战速决', desc: '30 回合内获胜' },
    { id: 'perfect_def', icon: '🛡️', name: '完美防守', desc: '获胜且全场未让对方成四' },
    { id: 'daily_clear', icon: '📅', name: '每日挑战者', desc: '完成一次每日挑战' }
  ];

  // ---------------- 存档（版本化 + 异常保护） ----------------
  var Store = {
    get: function (key, def) {
      var raw = null;
      try { raw = localStorage.getItem(key); if (raw == null) return def; return JSON.parse(raw); }
      catch (e) {
        console.warn('存档读取失败，已备份并重建', key, e);
        try { if (raw != null) localStorage.setItem(key + '_corrupt_' + Date.now(), raw); } catch (e2) { /* ignore */ }
        return def;
      }
    },
    set: function (key, val) {
      try { localStorage.setItem(key, JSON.stringify(val)); return true; }
      catch (e) { console.warn('存档写入失败', key, e); return false; }
    }
  };
  function defaultData() {
    return {
      schema_version: SCHEMA_VERSION, games: 0, wins: 0, losses: 0, draws: 0, streak: 0, bestStreak: 0,
      winsByDiff: { easy: 0, medium: 0, hard: 0 }, gamesByDiff: { easy: 0, medium: 0, hard: 0 },
      fastestWin: null, achievements: {}, tutorialSeen: false, freeHintUsed: false, lastFirst: null, daily: {}
    };
  }
  function migrate(d) {
    var def = defaultData();
    if (!d || typeof d !== 'object' || Array.isArray(d)) return def;
    // v1（V1.0 player_data.json 字段）→ v2
    if (!d.schema_version || d.schema_version < 2) {
      if (typeof d.current_streak === 'number') d.streak = d.current_streak;
      if (typeof d.max_streak === 'number') d.bestStreak = d.max_streak;
    }
    for (var k in def) if (!(k in d) || d[k] === null && def[k] !== null) d[k] = def[k];
    ['winsByDiff', 'gamesByDiff'].forEach(function (k) { for (var j in def[k]) if (typeof d[k][j] !== 'number') d[k][j] = 0; });
    ['games', 'wins', 'losses', 'draws', 'streak', 'bestStreak'].forEach(function (k) { if (typeof d[k] !== 'number' || !isFinite(d[k])) d[k] = 0; });
    d.schema_version = SCHEMA_VERSION;
    return d;
  }
  var data = migrate(Store.get('mg_data', null));
  var defaultSettings = { mode: 'ai', difficulty: 'medium', timer: 30, first: 'alternate', colorBlind: false, sound: true, haptics: true, coords: false, tutorial: 'once', hintMode: 'defense' };
  var settings = Object.assign({}, defaultSettings, Store.get('mg_settings', {}) || {});
  function saveData() { Store.set('mg_data', data); }
  function saveSettings() { Store.set('mg_settings', settings); }

  function points(d) {
    d = d || data;
    var p = d.wins * 10 + d.bestStreak * 5 + d.games * 1;
    for (var k in DIFF_COEF) p += DIFF_COEF[k] * (d.winsByDiff[k] || 0);
    return p;
  }
  function tierOf(p) {
    var i = 0; while (i + 1 < TIERS.length && p >= TIERS[i + 1].min) i++;
    var cur = TIERS[i], next = TIERS[i + 1] || null;
    var prog = next ? (p - cur.min) / (next.min - cur.min) : 1;
    return { tier: cur, next: next, progress: Math.max(0, Math.min(1, prog)), index: i };
  }

  // ---------------- 音效（WebAudio 占位音，可静音） ----------------
  var Sound = {
    ctx: null,
    unlock: function () {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
      try { var AC = window.AudioContext || window.webkitAudioContext; if (AC) this.ctx = new AC(); } catch (e) { this.ctx = null; }
    },
    tone: function (f, dur, type, gain, delay, slideTo) {
      var c = this.ctx; if (!c) return;
      var t = c.currentTime + (delay || 0), o = c.createOscillator(), g = c.createGain();
      o.type = type || 'sine'; o.frequency.setValueAtTime(f, t);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain || 0.15, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
    },
    play: function (name) {
      if (!settings.sound) return;
      this.unlock(); if (!this.ctx) return;
      var s = this;
      switch (name) {
        case 'select': s.tone(880, 0.05, 'sine', 0.08); break;
        case 'move': s.tone(320, 0.06, 'triangle', 0.18, 0, 180); s.tone(140, 0.08, 'sine', 0.2, 0.05); break;
        case 'illegal': s.tone(150, 0.16, 'square', 0.06); break;
        case 'tick': s.tone(1250, 0.04, 'sine', 0.07); break;
        case 'boost': s.tone(420, 0.3, 'sawtooth', 0.06, 0, 1000); s.tone(1000, 0.15, 'sine', 0.08, 0.28); break;
        case 'hint': s.tone(700, 0.08, 'sine', 0.1); s.tone(1050, 0.1, 'sine', 0.1, 0.08); break;
        case 'win': [523, 659, 784, 1046].forEach(function (f, i) { s.tone(f, 0.22, 'triangle', 0.16, i * 0.11); }); break;
        case 'lose': [392, 330, 262].forEach(function (f, i) { s.tone(f, 0.28, 'sine', 0.14, i * 0.16); }); break;
        case 'draw': s.tone(523, 0.2, 'sine', 0.12); s.tone(523, 0.25, 'sine', 0.12, 0.22); break;
        case 'ach': [784, 988, 1318].forEach(function (f, i) { s.tone(f, 0.16, 'sine', 0.12, i * 0.08); }); break;
        case 'undo': s.tone(500, 0.08, 'sine', 0.1, 0, 300); break;
      }
    }
  };
  function vib(p) { if (settings.haptics && navigator.vibrate) { try { navigator.vibrate(p); } catch (e) { /* ignore */ } } }

  // ---------------- AI 调度（Web Worker，失败回退主线程异步） ----------------
  var worker = null, workerOk = true, pending = {}, reqSeq = 0;
  function initWorker() {
    try {
      worker = new Worker('js/ai-worker.js');
      worker.onmessage = function (ev) { var cb = pending[ev.data.id]; delete pending[ev.data.id]; if (cb) cb(ev.data); };
      worker.onerror = function (e) { console.warn('AI Worker 出错，改用主线程', e && e.message); workerOk = false; flushPending(); };
    } catch (e) { workerOk = false; }
  }
  function flushPending() { for (var id in pending) { var cb = pending[id]; delete pending[id]; cb({ ok: false, error: 'worker' }); } }
  function requestAI(game, level, budget) {
    var state = game.serialize();
    return new Promise(function (resolve) {
      var local = function () {
        setTimeout(function () {
          try { resolve(AIM.chooseMove(E.Game.fromState(state), { level: level, timeBudget: budget })); }
          catch (e) { console.error(e); resolve(null); }
        }, 30);
      };
      if (worker && workerOk) {
        var id = ++reqSeq;
        pending[id] = function (res) { if (res.ok) resolve(res.move); else local(); };
        try { worker.postMessage({ id: id, state: state, level: level, timeBudget: budget }); }
        catch (e) { delete pending[id]; local(); }
      } else local();
    });
  }

  // ---------------- UI 工具 ----------------
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(function (s) { s.classList.toggle('active', s.id === id); });
    if (id === 'screen-game') requestAnimationFrame(layoutBoard);
  }
  function toast(text, cls, ms) {
    var el = document.createElement('div'); el.className = 'toast ' + (cls || ''); el.textContent = text;
    $('#toast-root').appendChild(el);
    setTimeout(function () { el.classList.add('out'); setTimeout(function () { el.remove(); }, 320); }, ms || 2200);
  }
  var openModals = 0;
  function modal(opts) {
    var root = $('#modal-root'), bd = document.createElement('div'); bd.className = 'backdrop';
    var m = document.createElement('div'); m.className = 'modal ' + (opts.cls || '');
    if (opts.title) { var h = document.createElement('h2'); h.textContent = opts.title; m.appendChild(h); }
    var body = document.createElement('div'); body.className = 'mbody scroll';
    if (typeof opts.html === 'string') body.innerHTML = opts.html; else if (opts.html) body.appendChild(opts.html);
    m.appendChild(body);
    var btns = document.createElement('div'); btns.className = 'mbtns'; m.appendChild(btns);
    bd.appendChild(m); root.appendChild(bd);
    openModals++; onModalChange();
    var closed = false;
    function close() {
      if (closed) return; closed = true; bd.remove(); openModals--; onModalChange();
      if (opts.onClose) opts.onClose();
    }
    (opts.buttons || []).forEach(function (b) {
      var el = document.createElement('button'); el.className = 'btn ' + (b.cls || ''); el.textContent = b.text;
      el.addEventListener('click', function () { Sound.unlock(); if (!b.keepOpen) close(); if (b.onClick) b.onClick(); });
      btns.appendChild(el);
    });
    if (!(opts.buttons || []).length) btns.remove();
    if (opts.dismissible) bd.addEventListener('click', function (e) { if (e.target === bd) close(); });
    if (opts.onOpen) opts.onOpen(body, close);
    return { close: close, body: body, el: m };
  }
  function confirmBox(title, text, okText, onOk, cancelText) {
    return modal({ title: title, html: '<p style="text-align:center">' + text + '</p>', buttons: [
      { text: cancelText || '取消', cls: 'ghost' }, { text: okText || '确定', cls: 'primary', onClick: onOk }
    ] });
  }
  function setMsg(text, cls) { var el = $('#msg'); el.textContent = text || ''; el.className = 'msg ' + (cls || ''); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmtTime(ms) { var s = Math.round(ms / 1000), m = Math.floor(s / 60); s %= 60; return m + ':' + (s < 10 ? '0' : '') + s; }
  function todayKey() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

  // ---------------- 主菜单 ----------------
  function renderMenu() {
    var p = points(), t = tierOf(p);
    $('#rank-card').innerHTML =
      '<div class="rank-top"><div class="rank-emblem" style="background:' + t.tier.color + '">' + t.tier.name[0] + '</div>' +
      '<div><div class="rank-name">' + t.tier.name + '</div><div class="rank-pts">积分 ' + p + '</div></div></div>' +
      '<div class="bar"><i style="width:' + Math.round(t.progress * 100) + '%"></i></div>' +
      '<div class="rank-next">' + (t.next ? '距「' + t.next.name + '」还差 ' + (t.next.min - p) + ' 分' : '已达最高段位') +
      ' · 积分 = 胜×10 + 最高连胜×5 + 对局×1 + 难度系数×胜</div>';
    var rate = data.games ? Math.round(data.wins / data.games * 100) : 0;
    var dr = Object.keys(DIFF).map(function (k) {
      var g = data.gamesByDiff[k] || 0;
      return '<span>' + DIFF[k] + ' <b>' + (g ? Math.round((data.winsByDiff[k] || 0) / g * 100) + '%' : '—') + '</b> <small>(' + g + '局)</small></span>';
    }).join('');
    $('#stats-card').innerHTML = '<div class="stats-grid">' +
      '<div><b>' + data.wins + '</b><small>胜</small></div><div><b>' + data.losses + '</b><small>负</small></div><div><b>' + data.draws + '</b><small>和</small></div>' +
      '<div><b>' + rate + '%</b><small>胜率</small></div><div><b>' + data.streak + '</b><small>当前连胜</small></div><div><b>' + data.bestStreak + '</b><small>最高连胜</small></div>' +
      '</div><div class="diff-rates">' + dr + '</div>';
    $('#cur-setting').textContent = (settings.mode === 'ai' ? '人机对战 · ' + DIFF[settings.difficulty] : '双人同屏') +
      ' · 每回合 ' + settings.timer + ' 秒 · ' + ({ alternate: '轮换先手', red: '红方先手', blue: '蓝方先手' })[settings.first];
    var d = data.daily[todayKey()];
    $('#daily-state').textContent = d && d.done ? '今日已完成 ✓（' + d.moves + ' 手）' : '今日未完成 · ' + DAILY_MOVE_LIMIT + ' 手内击败中级 AI';
    document.body.classList.toggle('cb', !!settings.colorBlind);
  }

  // ---------------- 设置 ----------------
  function openSettings() {
    var rows = [
      ['mode', '对战模式', [['ai', '人机对战'], ['pvp', '双人同屏']]],
      ['difficulty', 'AI 难度', [['easy', '初级'], ['medium', '中级'], ['hard', '高级']], '初级：随机但不送死；中级：2 层搜索；高级：3 层搜索 + 防守优先'],
      ['timer', '回合计时', [[15, '快速 15秒'], [30, '标准 30秒'], [60, '休闲 60秒']], '超时将自动走当前最优步'],
      ['first', '先手', [['alternate', '每局轮换'], ['red', '红方先'], ['blue', '蓝方先']], '人机模式中你执红方'],
      ['colorBlind', '棋子样式', [[false, '颜色区分'], [true, '形状区分（色弱）']]],
      ['sound', '音效', [[true, '开'], [false, '关']]],
      ['haptics', '震动反馈', [[true, '开'], [false, '关']], 'iPhone Safari 不支持网页震动，将自动忽略'],
      ['coords', '棋盘坐标', [[false, '隐藏'], [true, '显示 A1…J10']]],
      ['tutorial', '新手引导', [['once', '只看一遍'], ['always', '每局提示'], ['off', '关闭']]]
    ];
    var wrap = document.createElement('div');
    rows.forEach(function (r) {
      var row = document.createElement('div'); row.className = 'set-row';
      row.innerHTML = '<label>' + r[1] + '</label>';
      var seg = document.createElement('div'); seg.className = 'seg';
      r[2].forEach(function (o) {
        var b = document.createElement('button'); b.textContent = o[1];
        if (settings[r[0]] === o[0]) b.classList.add('on');
        b.addEventListener('click', function () {
          settings[r[0]] = o[0]; saveSettings();
          seg.querySelectorAll('button').forEach(function (x) { x.classList.remove('on'); }); b.classList.add('on');
          Sound.play('select'); renderMenu(); applyLiveSettings();
        });
        seg.appendChild(b);
      });
      row.appendChild(seg);
      if (r[3]) { var n = document.createElement('div'); n.className = 'set-note'; n.textContent = r[3]; row.appendChild(n); }
      wrap.appendChild(row);
    });
    var reset = document.createElement('div'); reset.className = 'set-row';
    var rb = document.createElement('button'); rb.className = 'btn ghost'; rb.textContent = '重置战绩与成就';
    rb.addEventListener('click', function () {
      confirmBox('重置数据', '确定清空全部战绩、段位与成就吗？此操作不可撤销。', '清空', function () { data = defaultData(); data.tutorialSeen = true; saveData(); renderMenu(); toast('数据已重置'); });
    });
    reset.appendChild(rb); wrap.appendChild(reset);
    modal({ title: '设置', html: wrap, buttons: [{ text: '完成', cls: 'primary' }], dismissible: true });
  }
  function applyLiveSettings() {
    document.body.classList.toggle('cb', !!settings.colorBlind);
    $('#btn-mute').classList.toggle('muted', !settings.sound);
    if (S) { renderCoords(); updateUI(); }
  }

  // ---------------- 成就 ----------------
  function openAchievements() {
    var html = '<div class="ach-list">' + ACHIEVEMENTS.map(function (a) {
      var on = data.achievements[a.id];
      return '<div class="ach ' + (on ? 'on' : '') + '"><div class="ai">' + a.icon + '</div><div><b>' + a.name + '</b><small>' + a.desc + '</small></div>' +
        '<div class="ad">' + (on ? new Date(on).toLocaleDateString('zh-CN') : '未解锁') + '</div></div>';
    }).join('') + '</div>';
    var n = ACHIEVEMENTS.filter(function (a) { return data.achievements[a.id]; }).length;
    modal({ title: '成就 ' + n + '/' + ACHIEVEMENTS.length, html: html, buttons: [{ text: '关闭', cls: 'primary' }], dismissible: true });
  }
  function unlock(id) {
    if (data.achievements[id]) return false;
    data.achievements[id] = Date.now();
    var a = ACHIEVEMENTS.filter(function (x) { return x.id === id; })[0];
    setTimeout(function () { toast('🏆 成就解锁：' + a.name + ' — ' + a.desc, 'gold', 3200); Sound.play('ach'); vib([20, 40, 20]); }, 900);
    return true;
  }

  // ---------------- 新手引导（三段式） ----------------
  function miniBoard(stones) {
    return '<div class="mini">' + stones.map(function (s) {
      return '<div class="ms ' + s[2] + '" style="left:' + s[1] * 38 + 'px;top:' + s[0] * 38 + 'px"></div>';
    }).join('') + '</div>';
  }
  function openTutorial(onDone) {
    var steps = [
      { t: '① 移动棋子', h: miniBoard([[2, 1, 'r mover'], [2, 2, 'dot'], [1, 1, 'dot'], [3, 1, 'dot'], [2, 0, 'dot'], [1, 3, 'b'], [3, 3, 'b'], [0, 0, 'r']]) +
        '<p>双方各 15 子随机（公平对称）摆在 10×10 棋盘上。轮到你时，<b>按住己方棋子拖到相邻空格</b>松手即可，只能<b>横向或纵向走 1 格</b>。绿点为可达格；放到非法位置会回弹。也可以<b>先点棋子、再点目标格</b>。</p>' },
      { t: '② 连成五子获胜', h: miniBoard([[0, 0, 'r glow'], [1, 1, 'r glow'], [2, 2, 'r glow'], [3, 3, 'r glow'], [4, 4, 'r glow'], [0, 3, 'b'], [1, 4, 'b'], [3, 0, 'b']]) +
        '<p>横、竖、斜任一方向连成 <b>5 子</b>即获胜。连成 3 子称为<b>三连</b>。轮到某方却<b>无子可动</b>，该方判负。超过 240 回合按最大连子与机动性评分。</p>' },
      { t: '③ 加速 · 悔棋 · 提示', h: '<div class="chips">' +
        '<div><b>⚡ 加速</b>：双方连续 12 回合都没走出三连 → 进入 8 回合加速，可直走 2 格（中间须畅通），棋盘描金边并显示倒计时；出现三连即结束。</div>' +
        '<div><b>悔棋 ×3</b>：撤销你的上一步（人机模式同时撤销 AI 的回应）。</div>' +
        '<div><b>提示 ×2</b>：防守提示标出对方能成四的位置；进攻提示给出你的最佳连子走法。首次使用免费。</div>' +
        '<div><b>和棋</b>：连续 30 回合无人新成三连时可申请和棋。<b>计时</b>：超时自动走最优步。</div></div>' }
    ];
    var i = 0, m;
    function render() {
      var s = steps[i];
      m.body.innerHTML = '<div class="tut-step"><h3 style="margin:0 0 4px">' + s.t + '</h3>' + s.h + '</div><div class="tut-dots">' +
        steps.map(function (_, k) { return '<i class="' + (k === i ? 'on' : '') + '"></i>'; }).join('') + '</div>';
      var bs = m.el.querySelectorAll('.mbtns .btn');
      bs[0].textContent = i === 0 ? '跳过' : '上一步';
      bs[1].textContent = i === steps.length - 1 ? '开始游戏' : '下一步';
    }
    m = modal({ title: '玩法引导', html: '', buttons: [
      { text: '跳过', cls: 'ghost', keepOpen: true, onClick: function () { if (i === 0) { m.close(); } else { i--; render(); } } },
      { text: '下一步', cls: 'primary', keepOpen: true, onClick: function () { if (i < steps.length - 1) { i++; render(); } else m.close(); } }
    ], onClose: function () { data.tutorialSeen = true; saveData(); if (onDone) onDone(); } });
    render();
  }

  // ---------------- 对局状态 ----------------
  var S = null;           // 当前会话
  var cs = 40;            // 格子像素
  var stoneEls = {};      // pos → element
  var timerInt = null;

  function decideFirst(isDaily) {
    if (isDaily) return RED;
    if (settings.first === 'red') return RED;
    if (settings.first === 'blue') return BLUE;
    var f = data.lastFirst ? E.other(data.lastFirst) : (Math.random() < 0.5 ? RED : BLUE);
    return f;
  }
  function startGame(opts) {
    opts = opts || {};
    stopTimer();
    var isDaily = !!opts.daily;
    var first = decideFirst(isDaily);
    if (!isDaily) { data.lastFirst = first; saveData(); }
    var rng = isDaily ? E.mulberry32(E.hashString('daily-' + todayKey())) : Math.random;
    var mode = isDaily ? 'ai' : settings.mode;
    var game = new E.Game({}, { rng: rng, first: first });
    if (isDaily) game.rng = Math.random;
    S = {
      game: game, mode: mode, difficulty: isDaily ? 'medium' : settings.difficulty, daily: isDaily, human: RED,
      undoLeft: { 1: game.cfg.undoPerSide, 2: game.cfg.undoPerSide }, hintLeft: { 1: game.cfg.hintPerSide, 2: game.cfg.hintPerSide },
      selected: null, phase: 'idle', startTime: Date.now(), aiReq: 0, oppHad4: false, liveThrees: 0, humanMoves: 0,
      drawOffered: false, hints: [], timerLeft: null, recorded: false, token: {}
    };
    showScreen('screen-game');
    $('#game-sub').textContent = isDaily ? '每日挑战 · ' + todayKey() : (mode === 'ai' ? '人机 · ' + DIFF[S.difficulty] : '双人同屏');
    layoutBoard(); renderStones(); clearLine(); renderHL(); updateUI();
    setMsg(isDaily ? '目标：' + DAILY_MOVE_LIMIT + ' 手内击败中级 AI' : (SIDE_NAME[first] + '先手 · 开局' + (game.layoutInfo.method === 'symmetric' ? '镜像对称' : '随机均衡')), 'gold');
    var showTut = settings.tutorial === 'always' || (settings.tutorial === 'once' && !data.tutorialSeen);
    if (showTut) openTutorial(function () { beginTurn(); });
    else setTimeout(beginTurn, 300);
  }
  function isHumanTurn() { return S && (S.mode === 'pvp' || S.game.current === S.human); }
  function actor() { return S.mode === 'pvp' ? S.game.current : S.human; }

  function beginTurn() {
    if (!S) return;
    var g = S.game;
    stopTimer();
    if (g.result) { endGame(); return; }
    if (S.daily && S.humanMoves >= DAILY_MOVE_LIMIT && g.current === S.human) {
      g.result = { winner: E.other(S.human), reason: 'daily_limit' }; endGame(); return;
    }
    if (openModals > 0) { S.phase = 'paused'; updateUI(); return; }
    if (isHumanTurn()) { S.phase = 'human'; startTimer(); }
    else runAI();
    updateUI();
  }
  function onModalChange() {
    if (!S || S.phase === 'over') return;
    if (openModals > 0 && S.phase === 'human') { pauseTimer(); S.phase = 'paused'; updateUI(); }
    else if (openModals === 0 && S.phase === 'paused') {
      if (S.timerLeft != null && isHumanTurn()) { S.phase = 'human'; startTimer(S.timerLeft); updateUI(); }
      else beginTurn();
    }
  }

  function runAI(levelOverride, isAuto) {
    var g = S.game, myToken = S.token, req = ++S.aiReq, t0 = Date.now();
    S.phase = 'ai'; deselect(); updateUI();
    var level = levelOverride || S.difficulty;
    requestAI(g, level, isAuto ? 600 : AI_BUDGET).then(function (mv) {
      if (!S || S.token !== myToken || req !== S.aiReq || g.result) return;
      var wait = Math.max(0, (isAuto ? 150 : 450) - (Date.now() - t0));
      setTimeout(function () {
        if (!S || S.token !== myToken || req !== S.aiReq) return;
        if (!mv || !g.isLegal(mv.from, mv.to)) { // 兜底：任取一合法步
          var ms = g.legalMoves(); if (!ms.length) { beginTurn(); return; }
          mv = { from: ms[0] >> 8, to: ms[0] & 255 };
        }
        doMove(mv.from, mv.to, { auto: isAuto });
      }, wait);
    });
  }

  // ---------------- 计时 ----------------
  function startTimer(leftMs) {
    stopTimer();
    var total = settings.timer * 1000, left = leftMs != null ? leftMs : total, end = Date.now() + left, lastSec = null;
    S.timerLeft = left; S.timerTotal = total;
    var tick = function () {
      if (!S) return stopTimer();
      var rem = Math.max(0, end - Date.now()); S.timerLeft = rem;
      var sec = Math.ceil(rem / 1000);
      $('#timer-fill').style.width = (rem / total * 100) + '%';
      $('#timer-text').textContent = sec + ' 秒';
      var warn = rem <= 5000;
      $('#timer').classList.toggle('warn', warn);
      if (warn && sec !== lastSec && sec > 0) { Sound.play('tick'); if (sec <= 3) vib(15); }
      lastSec = sec;
      if (rem <= 0) { stopTimer(); onTimeout(); }
    };
    tick(); timerInt = setInterval(tick, 100);
  }
  function stopTimer() { if (timerInt) { clearInterval(timerInt); timerInt = null; } $('#timer') && $('#timer').classList.remove('warn'); }
  function pauseTimer() { if (timerInt) { clearInterval(timerInt); timerInt = null; } }
  function onTimeout() {
    if (!S || S.phase !== 'human') return;
    setMsg('时间到，自动落子', 'warn'); toast('⏰ 时间到，自动落子'); vib([40, 30, 40]);
    S.timerLeft = null; cancelDrag();
    runAI('medium', true);
  }

  // ---------------- 走子 ----------------
  function doMove(from, to, meta) {
    meta = meta || {};
    var g = S.game, mover = g.current;
    clearHints();
    var entry;
    try { entry = g.makeMove(from, to); }
    catch (e) { console.error(e); illegalFeedback(to, e.message); return false; }
    S.timerLeft = null;
    stopTimer();
    deselect();
    moveStoneEl(from, to, meta.fromDrag);
    renderHL();
    Sound.play('move'); vib(12);
    if (S.mode === 'ai') {
      if (mover === S.human) {
        S.humanMoves++;
        if (g.liveThreeAt(to, mover)) S.liveThrees++;
      } else if (g.maxRunAt(to, mover) >= 4) S.oppHad4 = true;
    }
    if (!meta.auto) setMsg('');
    if (entry.boostStarted) { toast('⚡ 进入加速模式：8 回合内可直走 2 格', 'boost', 2600); Sound.play('boost'); vib([20, 30, 20]); }
    else if (entry.boostEnded && !g.result) setMsg(entry.formedTriple ? '出现三连，加速模式结束' : '加速回合用尽，恢复 1 格移动', 'gold');
    if (g.noProgress === g.cfg.noProgressLimit && !g.result) {
      S.drawOffered = true;
      setTimeout(function () { offerDrawPrompt(true); }, 400);
    }
    updateUI();
    S.phase = 'anim';
    setTimeout(function () { if (S && S.game === g) beginTurn(); }, g.result ? 350 : 190);
    return true;
  }

  // ---------------- 悔棋 / 提示 / 和棋 / 认输 ----------------
  function onUndo() {
    if (!S || S.game.result || S.phase !== 'human') return;
    var g = S.game;
    if (!g.history.length) { setMsg('还没有可以悔的棋', 'warn'); return; }
    var p, plies;
    if (S.mode === 'ai') {
      p = S.human;
      var idx = -1;
      for (var i = g.history.length - 1; i >= 0; i--) if (g.history[i].player === p) { idx = i; break; }
      if (idx < 0) { setMsg('你还没有走过棋', 'warn'); return; }
      plies = g.history.length - idx;
    } else { p = g.history[g.history.length - 1].player; plies = 1; }
    if (S.undoLeft[p] <= 0) { setMsg(SIDE_NAME[p] + '悔棋次数已用完', 'warn'); Sound.play('illegal'); return; }
    S.undoLeft[p]--;
    S.aiReq++; stopTimer(); clearHints(); deselect();
    for (var k = 0; k < plies; k++) {
      var e = g.undoMove();
      moveStoneEl(e.to, e.from, false);
      if (S.mode === 'ai' && e.player === S.human) S.humanMoves = Math.max(0, S.humanMoves - 1);
    }
    renderHL(); Sound.play('undo'); vib(10);
    setMsg(SIDE_NAME[p] + '悔棋（剩余 ' + S.undoLeft[p] + ' 次）', 'gold');
    updateUI();
    S.phase = 'anim';
    setTimeout(beginTurn, 200);
  }
  function onHint() {
    if (!S || S.game.result || S.phase !== 'human') return;
    var p = actor(), free = !data.freeHintUsed;
    if (!free && S.hintLeft[p] <= 0) { setMsg('提示次数已用完', 'warn'); Sound.play('illegal'); return; }
    modal({ title: '选择提示', cls: 'sheet', dismissible: true,
      html: '<p style="text-align:center;margin:0">' + (free ? '首次使用免费教学 1 次' : '剩余 ' + S.hintLeft[p] + ' 次') + '</p>',
      buttons: [
        { text: '🛡️ 防守提示：对方能在哪里成四/成五', cls: settings.hintMode === 'defense' ? 'primary' : '', onClick: function () { useHint('defense'); } },
        { text: '⚔️ 进攻提示：我的最佳连子走法', cls: settings.hintMode === 'attack' ? 'primary' : '', onClick: function () { useHint('attack'); } },
        { text: '取消', cls: 'ghost' }
      ] });
  }
  function useHint(kind) {
    if (!S || S.game.result) return;
    var g = S.game, p = actor();
    settings.hintMode = kind; saveSettings();
    clearHints();
    var found = false;
    if (kind === 'defense') {
      var hs = g.defenseHints(p);
      if (hs.length) {
        found = true;
        var seen = {};
        hs.forEach(function (h) { if (!seen[h.to]) { S.hints.push({ pos: h.to, cls: 'hint-def' }); seen[h.to] = 1; } S.hints.push({ pos: h.from, cls: 'hint-src' }); });
        var max = hs[0].len;
        setMsg('🛡️ 对方下一步可在 ' + Object.keys(seen).map(function (x) { return E.posName(+x); }).join('、') + ' 成' + (max >= 5 ? '五' : '四') + '，请封堵！', 'warn');
      } else setMsg('🛡️ 暂无对方成四威胁，可放心进攻');
    } else {
      var a = g.attackHint(p);
      if (a) {
        found = true;
        S.hints.push({ pos: a.from, cls: 'hint-atk-src' }, { pos: a.to, cls: 'hint-atk' });
        setMsg('⚔️ 建议 ' + E.posName(a.from) + ' → ' + E.posName(a.to) + '：' + (a.len >= 5 ? '直接成五！' : '可成 ' + a.len + ' 连' + (a.liveThree ? '（活三）' : '')), 'good');
      }
    }
    if (found) {
      if (!data.freeHintUsed) { data.freeHintUsed = true; saveData(); toast('首次提示免费'); }
      else S.hintLeft[p]--;
    }
    Sound.play('hint'); renderHL(); updateUI();
  }
  function offerDrawPrompt(auto) {
    if (!S || S.game.result || !S.game.canOfferDraw()) return;
    var intro = auto ? '已连续 ' + S.game.cfg.noProgressLimit + ' 回合无人新成三连。' : '';
    if (S.mode === 'ai') {
      if (auto && !isHumanTurn()) return; // AI 回合时不打断，按钮会高亮
      modal({ title: '和棋确认', html: '<p style="text-align:center">' + intro + '是否向 AI 提出和棋？<br><small>也可以继续对局，直到 ' + S.game.cfg.turnCap + ' 回合上限。</small></p>',
        buttons: [{ text: '继续对局', cls: 'ghost' }, { text: '提出和棋', cls: 'primary', onClick: askAIDraw }] });
    } else {
      var who = SIDE_NAME[S.game.current], oth = SIDE_NAME[E.other(S.game.current)];
      modal({ title: '和棋确认', html: '<p style="text-align:center">' + intro + (auto ? '双方是否同意和棋？' : who + '提出和棋，' + oth + '是否同意？') + '</p>',
        buttons: [{ text: '继续对局', cls: 'ghost' }, { text: '同意和棋', cls: 'primary', onClick: function () { if (S.game.agreeDraw()) endGame(); } }] });
    }
  }
  function askAIDraw() {
    var g = S.game, ai = E.other(S.human);
    var v = AIM.evaluatePosition(g, ai, S.difficulty);
    if (v <= 250) { if (g.agreeDraw()) { toast('AI 同意和棋'); endGame(); } }
    else { toast('AI 认为局势占优，拒绝和棋'); setMsg('AI 拒绝和棋', 'warn'); }
  }
  function onDraw() {
    if (!S || S.game.result || S.phase !== 'human') return;
    if (!S.game.canOfferDraw()) { setMsg('连续 ' + S.game.cfg.noProgressLimit + ' 回合无新三连后才可和棋（当前 ' + S.game.noProgress + '）', 'warn'); return; }
    offerDrawPrompt(false);
  }
  function onResign() {
    if (!S || S.game.result || (S.phase !== 'human' && S.phase !== 'ai')) return;
    var p = S.mode === 'ai' ? S.human : S.game.current;
    confirmBox('认输', (S.mode === 'ai' ? '确定认输吗？将记为一负。' : SIDE_NAME[p] + '确定认输吗？') + '<br><small>认输后可「再来一局」重新随机开局。</small>', '认输', function () {
      if (S && S.game.resign(p)) { S.aiReq++; endGame(); }
    });
  }
  function onBack() {
    if (!S || S.game.result || S.game.turn === 0) { goMenu(); return; }
    if (S.mode === 'ai') confirmBox('返回主菜单', '对局进行中，离开将视为认输。确定离开吗？', '离开', function () {
      if (S && S.game.resign(S.human)) { S.aiReq++; recordResult(); } goMenu();
    });
    else confirmBox('返回主菜单', '放弃当前双人对局？', '离开', goMenu);
  }
  function goMenu() { stopTimer(); if (S) { S.aiReq++; S.token = null; } S = null; renderMenu(); showScreen('screen-menu'); }

  // ---------------- 终局 ----------------
  function recordResult() {
    if (!S || S.recorded || S.mode !== 'ai') return null;
    S.recorded = true;
    var g = S.game, r = g.result, d = S.difficulty, before = points(), rec = [];
    var outcome = r.winner === 0 ? 'draw' : (r.winner === S.human ? 'win' : 'lose');
    data.games++; data.gamesByDiff[d] = (data.gamesByDiff[d] || 0) + 1;
    if (outcome === 'win') {
      data.wins++; data.winsByDiff[d] = (data.winsByDiff[d] || 0) + 1; data.streak++;
      if (data.streak > data.bestStreak) { data.bestStreak = data.streak; if (data.streak > 1) rec.push('新纪录：最高连胜 ' + data.streak); }
      if (data.fastestWin == null || g.turn < data.fastestWin) { if (data.fastestWin != null) rec.push('新纪录：最快获胜 ' + g.turn + ' 回合'); data.fastestWin = g.turn; }
      unlock('first_win');
      if (data.streak >= 5) unlock('streak5');
      if (d === 'hard') unlock('hard_win');
      if (g.turn <= 30) unlock('quick_win');
      if (!S.oppHad4) unlock('perfect_def');
      if (S.daily) {
        unlock('daily_clear');
        var k = todayKey(), prev = data.daily[k];
        if (!prev || !prev.done || S.humanMoves < prev.moves) data.daily[k] = { done: true, moves: S.humanMoves };
      }
    } else if (outcome === 'lose') { data.losses++; data.streak = 0; }
    else data.draws++;
    if (S.liveThrees >= 2) unlock('double_three');
    saveData();
    var after = points();
    return { outcome: outcome, delta: after - before, after: after, records: rec, tierBefore: tierOf(before).tier.name, tierAfter: tierOf(after).tier.name };
  }
  function endGame() {
    if (!S || S.phase === 'over') return;
    var g = S.game, r = g.result;
    S.phase = 'over'; stopTimer(); deselect(); cancelDrag();
    $('#timer-fill').style.width = '0%'; $('#timer-text').textContent = '对局结束';
    if (r.line) drawWinLine(r.line);
    var rec = recordResult();
    var outcome = r.winner === 0 ? 'draw' : (S.mode === 'ai' ? (r.winner === S.human ? 'win' : 'lose') : 'win');
    Sound.play(outcome === 'win' ? 'win' : outcome === 'lose' ? 'lose' : 'draw');
    vib(outcome === 'win' ? [30, 50, 30, 50, 80] : [60]);
    updateUI();
    var title = r.winner === 0 ? '和棋' : S.mode === 'ai' ? (r.winner === S.human ? '胜利！' : '失败') : SIDE_NAME[r.winner] + '获胜';
    setMsg(title + ' · ' + reasonText(r), outcome === 'win' ? 'gold' : '');
    setTimeout(function () { if (S && S.game === g) showEndPanel(title, outcome, rec); }, r.line ? 1300 : 600);
  }
  function reasonText(r) {
    switch (r.reason) {
      case 'five': return SIDE_NAME[r.winner] + '连成 ' + r.line.length + ' 子（' + E.posName(r.line[0]) + '–' + E.posName(r.line[r.line.length - 1]) + '）';
      case 'blocked': return SIDE_NAME[r.loser] + '无子可动，判负';
      case 'cap': var a = r.scores[1], b = r.scores[2];
        return '达到 ' + S.game.cfg.turnCap + ' 回合上限 · 评分：红 ' + a.maxRun + ' 连/' + a.mobility + ' 步，蓝 ' + b.maxRun + ' 连/' + b.mobility + ' 步' + (r.winner === 0 ? '，同分' : '');
      case 'agreed': return '双方同意和棋';
      case 'resign': return SIDE_NAME[r.loser] + '认输';
      case 'daily_limit': return '未能在 ' + DAILY_MOVE_LIMIT + ' 手内取胜，挑战失败';
    }
    return '';
  }
  function showEndPanel(title, outcome, rec) {
    var g = S.game, r = g.result;
    var html = '<div class="end-title ' + outcome + '">' + title + '</div><div class="end-reason">' + esc(reasonText(r)) + '</div>' +
      '<div class="end-grid"><div><small>总回合</small><b>' + g.turn + '</b></div><div><small>本局耗时</small><b>' + fmtTime(Date.now() - S.startTime) + '</b></div>' +
      '<div><small>红方最大连子</small><b>' + g.maxRun(RED) + '</b></div><div><small>蓝方最大连子</small><b>' + g.maxRun(BLUE) + '</b></div></div>';
    if (rec) {
      html += '<div class="end-extra">积分 ' + (rec.delta >= 0 ? '+' : '') + rec.delta + ' → ' + rec.after + ' · 段位 ' + rec.tierAfter +
        (rec.tierAfter !== rec.tierBefore ? ' <span class="rec">（晋升！）</span>' : '') +
        '<br>当前连胜 ' + data.streak + ' · 胜率 ' + (data.games ? Math.round(data.wins / data.games * 100) : 0) + '%' +
        rec.records.map(function (x) { return '<br><span class="rec">🎉 ' + x + '</span>'; }).join('') + '</div>';
      if (S.daily) html += '<div class="end-extra">' + (outcome === 'win' ? '<span class="rec">每日挑战完成！用时 ' + S.humanMoves + ' 手</span>' : '每日挑战未完成，可再次尝试') + '</div>';
    } else html += '<div class="end-extra" style="color:var(--dim)">双人对局不计入战绩</div>';
    var daily = S.daily;
    modal({ title: '对局结束', html: html, buttons: [
      { text: '返回主菜单', cls: 'ghost', onClick: goMenu },
      { text: '再来一局', cls: 'primary', onClick: function () { startGame({ daily: daily }); } }
    ] });
  }

  // ---------------- 渲染 ----------------
  function xy(p) { return [(p % 10) * cs, ((p / 10) | 0) * cs]; }
  function layoutBoard() {
    var wrap = $('#board-wrap'), b = $('#board');
    if (!wrap.clientWidth) return;
    var size = Math.floor(Math.min(wrap.clientWidth - 8, wrap.clientHeight - 8, 640) / 10) * 10;
    if (size < 200) size = 200;
    cs = size / 10;
    b.style.width = size + 'px'; b.style.height = size + 'px';
    b.style.backgroundSize = cs + 'px ' + cs + 'px, ' + cs + 'px ' + cs + 'px, 100% 100%, 100% 100%';
    $('#layer-line').setAttribute('viewBox', '0 0 ' + size + ' ' + size);
    for (var p in stoneEls) placeEl(stoneEls[p], +p);
    renderCoords(); renderHL();
    if (S && S.game.result && S.game.result.line) drawWinLine(S.game.result.line, true);
  }
  function placeEl(el, p) { var a = xy(p); el.style.width = cs + 'px'; el.style.height = cs + 'px'; el.style.transform = 'translate(' + a[0] + 'px,' + a[1] + 'px)'; }
  function renderStones() {
    var layer = $('#layer-stones'); layer.innerHTML = ''; stoneEls = {};
    if (!S) return;
    var g = S.game.grid;
    for (var p = 0; p < 100; p++) if (g[p]) {
      var el = document.createElement('div'); el.className = 'stone ' + (g[p] === RED ? 'red' : 'blue');
      el.innerHTML = '<div class="piece"></div>'; el.style.transition = 'none';
      placeEl(el, p); layer.appendChild(el); stoneEls[p] = el;
    }
    requestAnimationFrame(function () { for (var k in stoneEls) stoneEls[k].style.transition = ''; });
  }
  function moveStoneEl(from, to, fromDrag) {
    var el = stoneEls[from];
    if (!el) { renderStones(); return; }
    delete stoneEls[from]; stoneEls[to] = el;
    el.classList.remove('dragging', 'selected', 'win');
    el.style.transition = fromDrag ? 'transform 110ms ease-out' : '';
    placeEl(el, to);
    el.classList.remove('landed'); void el.offsetWidth; el.classList.add('landed');
    setTimeout(function () { el.style.transition = ''; }, 200);
  }
  function renderCoords() {
    var layer = $('#layer-coords'); layer.innerHTML = '';
    if (!settings.coords) return;
    for (var i = 0; i < 10; i++) {
      var a = document.createElement('div'); a.className = 'coord'; a.textContent = 'ABCDEFGHIJ'[i];
      a.style.left = (i * cs + 2) + 'px'; a.style.top = '1px'; layer.appendChild(a);
      var n = document.createElement('div'); n.className = 'coord'; n.textContent = i + 1;
      n.style.left = '2px'; n.style.top = (i * cs + cs - 12) + 'px'; layer.appendChild(n);
    }
  }
  var ARROWS = {}; // 可达格方向箭头
  function renderHL() {
    var layer = $('#layer-hl'); layer.innerHTML = '';
    if (!S) return;
    var g = S.game, add = function (p, cls, inner) {
      var d = document.createElement('div'); d.className = 'hl ' + cls; d.dataset.pos = p;
      var a = xy(p); d.style.width = cs + 'px'; d.style.height = cs + 'px'; d.style.transform = 'translate(' + a[0] + 'px,' + a[1] + 'px)';
      if (inner) d.innerHTML = inner; layer.appendChild(d); return d;
    };
    var last = g.history[g.history.length - 1];
    if (last) { add(last.from, 'last-from'); add(last.to, 'last-to'); }
    S.hints.forEach(function (h) { add(h.pos, h.cls); });
    if (S.selected != null) {
      var sr = (S.selected / 10) | 0, sc = S.selected % 10;
      g.targets(S.selected).forEach(function (t) {
        var tr = (t / 10) | 0, tc = t % 10, far = Math.abs(tr - sr) + Math.abs(tc - sc) === 2;
        var ch = tr < sr ? '▲' : tr > sr ? '▼' : tc < sc ? '◀' : '▶';
        var pos = tr < sr ? 'top:6%' : tr > sr ? 'bottom:6%' : tc < sc ? 'left:8%' : 'right:8%';
        add(t, 'reach' + (far ? ' far' : ''), '<span class="arr" style="' + pos + '">' + ch + '</span>');
      });
    }
    Object.keys(stoneEls).forEach(function (p) { stoneEls[p].classList.toggle('selected', +p === S.selected); });
  }
  function clearHints() { if (S) S.hints = []; }
  function clearLine() { $('#layer-line').innerHTML = ''; }
  function drawWinLine(line, instant) {
    var a = xy(line[0]), b = xy(line[line.length - 1]), h = cs / 2;
    $('#layer-line').innerHTML = '<line class="winline" ' + (instant ? 'style="animation:none;stroke-dashoffset:0" ' : '') + 'x1="' + (a[0] + h) + '" y1="' + (a[1] + h) + '" x2="' + (b[0] + h) + '" y2="' + (b[1] + h) + '"/>';
    line.forEach(function (p) { if (stoneEls[p]) stoneEls[p].classList.add('win'); });
  }
  function illegalFeedback(pos, reason) {
    if (pos != null && pos >= 0) {
      var d = document.createElement('div'); d.className = 'hl bad';
      var a = xy(pos); d.style.width = cs + 'px'; d.style.height = cs + 'px'; d.style.transform = 'translate(' + a[0] + 'px,' + a[1] + 'px)';
      $('#layer-hl').appendChild(d); setTimeout(function () { d.remove(); }, 520);
    }
    setMsg('✖ ' + reason, 'warn'); Sound.play('illegal'); vib([30, 40, 30]);
  }
  function updateUI() {
    if (!S) return;
    var g = S.game, cur = g.current, over = !!g.result;
    var t = tierOf(points());
    $('#rank-badge').textContent = t.tier.name + ' · 连胜 ' + data.streak;
    $('#btn-mute').classList.toggle('muted', !settings.sound);
    [1, 2].forEach(function (p) {
      var chip = $('#chip-' + p);
      chip.className = 'pchip p' + p + (!over && cur === p ? ' active' : '');
      var name = SIDE_NAME[p] + (S.mode === 'ai' ? (p === S.human ? '（你）' : '（AI·' + DIFF[S.difficulty] + '）') : '');
      chip.querySelector('.pname').textContent = name;
      var meta = (S.mode === 'ai' && p !== S.human) ? '最大连子 ' + g.maxRun(p) : '悔棋 ' + S.undoLeft[p] + ' · 提示 ' + S.hintLeft[p];
      if (g.firstPlayer === p) meta += ' · 先手';
      chip.querySelector('.pmeta').textContent = meta;
    });
    var ti = $('#turn-ind');
    ti.className = 'turn-ind p' + cur + (S.phase === 'ai' ? ' thinking' : '');
    var txt;
    if (over) txt = '对局结束';
    else if (S.phase === 'ai') txt = S.mode === 'ai' && cur !== S.human ? 'AI 思考中' : '自动落子中';
    else txt = SIDE_NAME[cur] + (S.mode === 'ai' ? '（你）' : '') + '走棋' + (g.isBoost() ? ' · 可走 2 格' : '');
    $('#turn-text').textContent = txt;
    $('#turn-count').innerHTML = '第 ' + Math.min(g.turn + 1, g.cfg.turnCap) + '/' + g.cfg.turnCap + ' 回合<br>' +
      (g.isBoost() ? '加速剩余 ' + g.boostLeft : '无三连 ' + g.streak + '/' + g.cfg.boostTrigger) + ' · 无进展 ' + g.noProgress + '/' + g.cfg.noProgressLimit;
    $('#board').classList.toggle('boost', g.isBoost() && !over);
    $('#boost-banner').classList.toggle('hidden', !g.isBoost() || over);
    $('#boost-left').textContent = g.boostLeft;
    if (S.phase !== 'human' && S.phase !== 'paused') {
      $('#timer').classList.toggle('off', true);
      if (!over) { $('#timer-fill').style.width = '100%'; $('#timer-text').textContent = S.phase === 'ai' ? '对方回合' : ''; }
    } else $('#timer').classList.remove('off');
    var p = S.mode === 'ai' ? S.human : cur, humanTurn = S.phase === 'human';
    var undoP = S.mode === 'ai' ? S.human : (g.history.length ? g.history[g.history.length - 1].player : cur);
    $('#undo-n').textContent = S.undoLeft[undoP];
    $('#hint-n').textContent = !data.freeHintUsed ? '免费' : S.hintLeft[p];
    $('#btn-undo').disabled = over || !humanTurn || !g.history.length || S.undoLeft[undoP] <= 0;
    $('#btn-hint').disabled = over || !humanTurn || (data.freeHintUsed && S.hintLeft[p] <= 0);
    $('#btn-draw').disabled = over || !humanTurn;
    $('#btn-draw').classList.toggle('glow', g.canOfferDraw());
    $('#draw-n').textContent = g.canOfferDraw() ? '可' : '';
    $('#draw-n').style.display = g.canOfferDraw() ? '' : 'none';
    $('#btn-resign').disabled = over;
  }

  // ---------------- 输入：拖拽 + 点选 ----------------
  var drag = null;
  function cellAt(clientX, clientY) {
    var r = $('#board').getBoundingClientRect(), x = clientX - r.left, y = clientY - r.top;
    if (x < 0 || y < 0 || x >= r.width || y >= r.height) return -1;
    return Math.floor(y / cs) * 10 + Math.floor(x / cs);
  }
  function select(p) { S.selected = p; renderHL(); Sound.play('select'); vib(8); }
  function deselect() { if (S && S.selected != null) { S.selected = null; renderHL(); } }
  function cancelDrag() {
    if (!drag) return;
    var el = drag.el; if (el) { el.classList.remove('dragging'); if (stoneEls[drag.from] === el) placeEl(el, drag.from); }
    drag = null; clearHover();
  }
  function clearHover() { document.querySelectorAll('.hl.hover').forEach(function (h) { h.classList.remove('hover'); }); }
  function onDown(e) {
    Sound.unlock();
    if (!S || drag) return;
    if (S.phase !== 'human') {
      if (S.phase === 'ai') setMsg(S.mode === 'ai' ? 'AI 思考中，请稍候…' : '请稍候…');
      return;
    }
    e.preventDefault();
    var p = cellAt(e.clientX, e.clientY); if (p < 0) return;
    var g = S.game, me = g.current;
    if (g.grid[p] === me) {
      var was = S.selected === p;
      if (!was) select(p);
      drag = { id: e.pointerId, from: p, x0: e.clientX, y0: e.clientY, moved: false, el: stoneEls[p], was: was };
      try { $('#board').setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      return;
    }
    if (S.selected != null) {
      if (g.isLegal(S.selected, p)) { doMove(S.selected, p); return; }
      var why = g.grid[p] ? (g.grid[p] === me ? null : '那是对方的棋子') : g.explainIllegal(S.selected, p);
      illegalFeedback(p, why || '非法移动');
      return;
    }
    if (g.grid[p]) setMsg('那是' + SIDE_NAME[g.grid[p]] + '的棋子，请移动' + SIDE_NAME[me] + '棋子', 'warn');
    else setMsg('请先选择或拖动己方棋子');
  }
  function onMoveEv(e) {
    if (!drag || e.pointerId !== drag.id) return;
    e.preventDefault();
    var dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.moved && dx * dx + dy * dy > 64) { drag.moved = true; if (drag.el) drag.el.classList.add('dragging'); }
    if (!drag.moved || !drag.el) return;
    var r = $('#board').getBoundingClientRect();
    var x = e.clientX - r.left - cs / 2, y = e.clientY - r.top - cs / 2;
    drag.el.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    var p = cellAt(e.clientX, e.clientY);
    if (p !== drag.hover) {
      drag.hover = p; clearHover();
      var h = document.querySelector('.hl.reach[data-pos="' + p + '"]'); if (h) { h.classList.add('hover'); vib(5); }
    }
  }
  function onUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    var d = drag; drag = null; clearHover();
    try { $('#board').releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (!S || S.phase !== 'human') { if (d.el) { d.el.classList.remove('dragging'); placeEl(d.el, d.from); } return; }
    if (!d.moved) { if (d.was) deselect(); return; }
    var p = cellAt(e.clientX, e.clientY), g = S.game;
    if (p >= 0 && p !== d.from && g.isLegal(d.from, p)) { doMove(d.from, p, { fromDrag: true }); return; }
    // 回弹
    if (d.el) { d.el.classList.remove('dragging'); d.el.style.transition = 'transform 180ms cubic-bezier(.3,1.5,.5,1)'; placeEl(d.el, d.from); setTimeout(function () { d.el.style.transition = ''; }, 200); }
    if (p >= 0 && p !== d.from) illegalFeedback(p, g.explainIllegal(d.from, p) || '非法移动');
    else if (p < 0) illegalFeedback(null, '已移出棋盘，棋子回弹');
  }
  function onCancel(e) { if (drag && e.pointerId === drag.id) cancelDrag(); }

  // ---------------- 初始化 ----------------
  function bind() {
    var b = $('#board');
    b.addEventListener('pointerdown', onDown);
    b.addEventListener('pointermove', onMoveEv);
    b.addEventListener('pointerup', onUp);
    b.addEventListener('pointercancel', onCancel);
    b.addEventListener('lostpointercapture', function (e) { if (drag && e.pointerId === drag.id) setTimeout(function () { if (drag && drag.id === e.pointerId) cancelDrag(); }, 0); });
    b.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    $('#btn-start').addEventListener('click', function () { Sound.unlock(); startGame(); });
    $('#btn-daily').addEventListener('click', function () { Sound.unlock(); startGame({ daily: true }); });
    $('#btn-settings').addEventListener('click', openSettings);
    $('#btn-ach').addEventListener('click', openAchievements);
    $('#btn-help').addEventListener('click', function () { openTutorial(); });
    $('#btn-back').addEventListener('click', onBack);
    $('#btn-mute').addEventListener('click', function () { settings.sound = !settings.sound; saveSettings(); Sound.unlock(); applyLiveSettings(); toast(settings.sound ? '音效已开启' : '已静音'); });
    $('#btn-undo').addEventListener('click', onUndo);
    $('#btn-hint').addEventListener('click', onHint);
    $('#btn-draw').addEventListener('click', onDraw);
    $('#btn-resign').addEventListener('click', onResign);
    // 禁止页面缩放 / 回弹滚动（可滚动区域除外）
    document.addEventListener('touchmove', function (e) {
      if (e.touches && e.touches.length > 1) { e.preventDefault(); return; }
      var sc = e.target.closest && e.target.closest('.scroll');
      if (!sc || sc.scrollHeight <= sc.clientHeight) e.preventDefault();
    }, { passive: false });
    ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (t) { document.addEventListener(t, function (e) { e.preventDefault(); }, { passive: false }); });
    var lastTouch = 0;
    document.addEventListener('touchend', function (e) { var now = Date.now(); if (now - lastTouch < 300 && !e.target.closest('button')) e.preventDefault(); lastTouch = now; }, { passive: false });
    document.addEventListener('dblclick', function (e) { e.preventDefault(); });
    window.addEventListener('resize', function () { if (S) layoutBoard(); });
    window.addEventListener('orientationchange', function () { setTimeout(function () { if (S) layoutBoard(); }, 250); });
    document.addEventListener('visibilitychange', function () { if (document.hidden && Sound.ctx && Sound.ctx.state === 'running') Sound.ctx.suspend(); });
    // 桌面：方向键移动选中棋子（无障碍）
    document.addEventListener('keydown', function (e) {
      if (!S || S.phase !== 'human' || S.selected == null || openModals) return;
      var dirs = { ArrowUp: -10, ArrowDown: 10, ArrowLeft: -1, ArrowRight: 1 }; var dv = dirs[e.key]; if (!dv) return;
      e.preventDefault();
      var steps = e.shiftKey && S.game.isBoost() ? 2 : 1, to = S.selected + dv * steps;
      if ((dv === 1 || dv === -1) && ((to / 10) | 0) !== ((S.selected / 10) | 0)) { illegalFeedback(null, '超出棋盘'); return; }
      if (to >= 0 && to < 100 && S.game.isLegal(S.selected, to)) doMove(S.selected, to); else illegalFeedback(to >= 0 && to < 100 ? to : null, (to >= 0 && to < 100 && S.game.explainIllegal(S.selected, to)) || '超出棋盘');
    });
  }

  bind();
  initWorker();
  renderMenu();
  applyLiveSettings();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('SW 注册失败', e); }); });
  }
  // 供自动化测试使用
  window.__mg = { startGame: startGame, state: function () { return S; }, doMove: function (f, t) { return doMove(f, t); }, data: function () { return data; } };
})();
