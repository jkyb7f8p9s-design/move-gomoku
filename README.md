# 移动五子棋（PWA）

纯 HTML/CSS/JS，无构建、无外部依赖。直接用任意静态服务器托管本目录即可：

    python3 -m http.server 8787

iPhone：用 Safari 打开 https 地址 → 分享 → 添加到主屏幕。首次加载后 Service Worker 缓存全部资源，可离线游玩。

## 结构
- `js/engine.js`：纯逻辑模型（开局、移动、胜负、加速、和棋、悔棋、提示），浏览器 / Worker / Node 通用
- `js/ai.js`：AI（迭代加深 alpha-beta，深度 1/2/3，棋型 + 防守 + 机动性评估，make/undo + try/finally）
- `js/ai-worker.js`：AI Web Worker
- `js/app.js`：控制器 + 渲染 + 存档（schema_version）+ 音效
- `sw.js` / `manifest.json` / `icons/`：PWA

## 测试
    node tests/test.js              # 单元测试
    node tests/soak.js 150 40       # AI 对 AI 浸泡测试（局数, 每步预算 ms）
    NODE_PATH=<playwright-core 所在 node_modules> node tests/browser-smoke.js http://localhost:8787/
    NODE_PATH=... node tests/browser-flows.js http://localhost:8787/
