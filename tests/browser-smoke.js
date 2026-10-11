/* 无头 Chromium 冒烟测试 + 截图：NODE_PATH=/workspace/tools/node_modules node tests/browser-smoke.js [url] */
const { chromium } = require('playwright-core');
const path = require('path');
const URL = process.argv[2] || 'http://localhost:8787/';
const SHOTS = path.join(__dirname, '..', 'shots');
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await page.goto(URL, { waitUntil: 'networkidle' });
  // 截图用：初级 AI，避免随机走法过早输掉
  await page.evaluate(() => localStorage.setItem('mg_settings', JSON.stringify({ difficulty: 'easy', first: 'red' })));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, '01-menu.png') });

  await page.click('#btn-start');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, '02-tutorial.png') });
  for (let i = 0; i < 3; i++) { await page.click('.modal .mbtns .btn.primary'); await page.waitForTimeout(200); }
  // 确保轮到人类（若 AI 先手，等待其落子）
  await page.waitForFunction(() => window.__mg.state().phase === 'human', null, { timeout: 15000 });

  // 用真实指针拖动：找一颗有可达格的红子
  const box = await page.locator('#board').boundingBox();
  const mv = await page.evaluate(() => {
    const g = window.__mg.state().game; const m = g.legalMoves(); return { from: m[0] >> 8, to: m[0] & 255 };
  });
  const cell = box.width / 10, c = p => [box.x + (p % 10 + 0.5) * cell, box.y + (Math.floor(p / 10) + 0.5) * cell];
  // 先演示非法拖动回弹（拖到斜角）
  const [fx, fy] = c(mv.from);
  await page.mouse.move(fx, fy); await page.mouse.down();
  await page.mouse.move(fx + cell * 0.6, fy + cell * 0.5, { steps: 5 });
  await page.screenshot({ path: path.join(SHOTS, '03-dragging.png') });
  await page.mouse.move(fx + cell * 3, fy + cell * 3, { steps: 5 }); await page.mouse.up();
  await page.waitForTimeout(300);
  const msgIllegal = await page.textContent('#msg');
  const turnAfterIllegal = await page.evaluate(() => window.__mg.state().game.turn);
  // 合法拖动
  const [tx, ty] = c(mv.to);
  await page.mouse.move(fx, fy); await page.mouse.down();
  await page.mouse.move(tx, ty, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(300);
  const turnAfterDrag = await page.evaluate(() => window.__mg.state().game.turn);
  // 等 AI 回应，然后再用点选两步走几手
  for (let k = 0; k < 4; k++) {
    await page.waitForFunction(() => { const s = window.__mg.state(); return s && (s.phase === 'human' || s.phase === 'over'); }, null, { timeout: 15000 });
    const st = await page.evaluate(() => { const s = window.__mg.state(); if (s.phase === 'over') return null; return MGAI.chooseMove(MGEngine.Game.fromState(s.game.serialize()), { level: 'medium', timeBudget: 200 }); });
    if (!st) break;
    const [ax, ay] = c(st.from), [bx, by] = c(st.to);
    await page.mouse.click(ax, ay); await page.waitForTimeout(120);
    if (k === 3) { await page.screenshot({ path: path.join(SHOTS, '04-selected.png') }); }
    await page.mouse.click(bx, by); await page.waitForTimeout(250);
  }
  await page.waitForFunction(() => { const s = window.__mg.state(); return s && (s.phase === 'human' || s.phase === 'over'); }, null, { timeout: 15000 });
  await page.screenshot({ path: path.join(SHOTS, '05-in-game.png') });
  // 提示
  const phase = await page.evaluate(() => window.__mg.state().phase);
  if (phase === 'human') {
    await page.click('#btn-hint'); await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(SHOTS, '06-hint-sheet.png') });
    await page.click('.modal .mbtns .btn >> nth=1'); await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, '07-attack-hint.png') });
  }
  // 加速模式展示：直接设置状态后刷新 UI
  await page.evaluate(() => { const s = window.__mg.state(); if (s.phase !== 'over') { s.game.boostLeft = 6; } });
  await page.mouse.click(box.x + 2, box.y + box.height + 30); // 触发无害点击
  await page.evaluate(() => document.querySelector('#btn-mute').click());
  await page.evaluate(() => document.querySelector('#btn-mute').click());
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, '08-boost.png') });
  // 认输 → 终局面板
  if (await page.evaluate(() => window.__mg.state().phase !== 'over')) {
    await page.waitForFunction(() => window.__mg.state().phase === 'human', null, { timeout: 15000 });
    await page.click('#btn-resign'); await page.waitForTimeout(200);
    await page.click('.modal .mbtns .btn.primary');
  }
  await page.waitForTimeout(1600);
  await page.screenshot({ path: path.join(SHOTS, '09-end-panel.png') });
  await page.click('.modal .mbtns .btn.ghost'); await page.waitForTimeout(300);
  await page.click('#btn-settings'); await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, '10-settings.png') });
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('mg_data')));
  const sw = await page.evaluate(() => 'serviceWorker' in navigator);
  console.log(JSON.stringify({ msgIllegal, turnAfterIllegal, turnAfterDrag, storedGames: stored.games, storedLosses: stored.losses, schema: stored.schema_version, swSupported: sw, consoleErrors: errors }, null, 1));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
