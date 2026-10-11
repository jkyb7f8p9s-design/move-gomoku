/* AI Web Worker：在后台线程搜索，避免 UI 卡顿 */
importScripts('engine.js', 'ai.js');
self.onmessage = function (ev) {
  var msg = ev.data;
  try {
    var game = MGEngine.Game.fromState(msg.state);
    var res = MGAI.chooseMove(game, { level: msg.level, timeBudget: msg.timeBudget });
    self.postMessage({ id: msg.id, ok: true, move: res });
  } catch (e) {
    self.postMessage({ id: msg.id, ok: false, error: String(e && e.message || e) });
  }
};
