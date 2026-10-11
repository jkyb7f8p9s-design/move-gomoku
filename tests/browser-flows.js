/* 流程测试：双人模式超时自动落子、悔棋、和棋按钮、每日挑战、离线（SW） */
const { chromium } = require('playwright-core');
const URL = process.argv[2] || 'http://localhost:8787/';
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  const out = {};
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.evaluate(() => { localStorage.setItem('mg_settings', JSON.stringify({ mode: 'pvp', timer: 15, tutorial: 'off', first: 'red' })); localStorage.setItem('mg_data', '{corrupt json'); });
  await page.reload({ waitUntil: 'networkidle' });
  out.corruptRecovered = await page.evaluate(() => window.__mg.data().schema_version === 2 && Object.keys(localStorage).some(k => k.startsWith('mg_data_corrupt_')));
  await page.click('#btn-start');
  await page.waitForFunction(() => window.__mg.state().phase === 'human');
  // 悔棋（双人）
  await page.evaluate(() => { const g = window.__mg.state().game; const m = g.legalMoves()[0]; window.__mg.doMove(m >> 8, m & 255); });
  await page.waitForFunction(() => window.__mg.state().phase === 'human');
  await page.click('#btn-undo');
  await page.waitForFunction(() => window.__mg.state().phase === 'human');
  out.pvpUndo = await page.evaluate(() => { const s = window.__mg.state(); return { turn: s.game.turn, current: s.game.current, undoLeftRed: s.undoLeft[1] }; });
  // 超时自动落子（15 秒）
  const t0 = Date.now();
  await page.waitForFunction(() => window.__mg.state().game.turn === 1, null, { timeout: 25000 });
  out.timeoutAutoMoveAfterMs = Date.now() - t0;
  out.timeoutMsg = await page.textContent('#toast-root');
  // 和棋按钮：强制无进展计数
  await page.waitForFunction(() => window.__mg.state().phase === 'human');
  await page.evaluate(() => { window.__mg.state().game.noProgress = 30; });
  await page.click('#btn-draw'); await page.waitForTimeout(200);
  await page.click('.modal .mbtns .btn.primary'); await page.waitForTimeout(800);
  out.drawResult = await page.evaluate(() => window.__mg.state().game.result);
  await page.waitForSelector('.modal .end-title');
  out.endTitle = await page.textContent('.modal .end-title');
  await page.click('.modal .mbtns .btn.ghost');
  // 每日挑战：同一天两次开局布局相同
  const layout = async () => { await page.click('#btn-daily'); await page.waitForTimeout(300); const g = await page.evaluate(() => Array.from(window.__mg.state().game.grid).join('')); await page.click('#btn-back'); await page.waitForTimeout(200); const m = await page.$('.modal .btn.primary'); if (m) await m.click(); await page.waitForTimeout(200); return g; };
  const a = await layout(), b = await layout();
  out.dailySameLayout = a === b;
  // 人机悔棋：撤销 AI 回应 + 自己的一步
  await page.evaluate(() => localStorage.setItem('mg_settings', JSON.stringify({ mode: 'ai', difficulty: 'hard', tutorial: 'off', first: 'red' })));
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('#btn-start');
  await page.waitForFunction(() => window.__mg.state().phase === 'human');
  const before = await page.evaluate(() => Array.from(window.__mg.state().game.grid).join(''));
  await page.evaluate(() => { const g = window.__mg.state().game; const m = g.legalMoves()[0]; window.__mg.doMove(m >> 8, m & 255); });
  const tAI = Date.now();
  await page.waitForFunction(() => { const s = window.__mg.state(); return s.phase === 'human' || s.phase === 'over'; }, null, { timeout: 15000 });
  out.hardAIResponseMs = Date.now() - tAI;
  if (await page.evaluate(() => window.__mg.state().phase === 'human')) {
    await page.click('#btn-undo'); await page.waitForTimeout(400);
    out.aiUndoRestored = (await page.evaluate(() => Array.from(window.__mg.state().game.grid).join(''))) === before;
  }
  // 离线：SW 接管后断网刷新
  await page.waitForTimeout(1500);
  out.swControlled = await page.evaluate(async () => { await navigator.serviceWorker.ready; return !!navigator.serviceWorker.controller || 'ready'; });
  await ctx.setOffline(true);
  await page.reload({ waitUntil: 'load' }).catch(e => out.offlineErr = e.message);
  out.offlineTitle = await page.textContent('h1').catch(() => null);
  out.offlineWorkerAI = await page.evaluate(() => typeof MGAI === 'object');
  out.errors = errors;
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
