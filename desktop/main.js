// ══════════════════════════════════════════════════════════
// 小墨实验室 · 桌面版 · 主进程
//
// 设计取舍：
//   · 最低兼容 Windows 10 —— 不调用 Mica / 云母 / 圆角等 Win11 专属
//     接口，标题栏自绘、圆角与毛玻璃交给 CSS，两端表现一致。
//   · 渲染进程就是浏览器版那份网页代码，桌面能力通过预加载桥注入，
//     所以同一个前端既能跑在浏览器里，也能跑在这个窗口里。
//   · 前端是原生 ES Module，file:// 下会被 CORS 拒绝，
//     因此注册自定义 app:// 协议并显式给 MIME。
//
// 启动：npm start      （开发：npm run dev，带开发者工具）
// ══════════════════════════════════════════════════════════

'use strict';

const {
  app, BrowserWindow, protocol, ipcMain, Menu, shell,
  dialog, nativeTheme, screen,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const IS_DEV = process.argv.includes('--dev');
const SELFTEST = process.argv.includes('--selftest');
const SCHEME = 'app';
const HOST = 'xiaomo-lab';
const APP_URL = `${SCHEME}://${HOST}/index.html`;

// ─────────────────────────────────────────────────────────
// 前端资源根目录
//   前端只有一份，桌面版与网页版不分叉，按候选顺序找：
//     ① desktop/app/ —— 打包时把前端产物放这儿
//     ② 上一级目录   —— 仓库根，也是 npm 安装后 xiaomo-lab 的包根
//   __dirname 始终是主进程文件所在目录，跟启动方式无关，所以
//   npm i -g、npx、仓库里直接跑，三种情形解析结果一致。
// ─────────────────────────────────────────────────────────
function resolveAppRoot() {
  const candidates = [path.join(__dirname, 'app'), path.resolve(__dirname, '..')];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  console.error('[桌面版] 找不到 index.html，检查过：' + candidates.join('  |  '));
  return candidates[1];
}
const APP_ROOT = resolveAppRoot();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

// ─────────────────────────────────────────────────────────
// 窗口状态记忆（尺寸 / 位置 / 最大化）
// ─────────────────────────────────────────────────────────
function stateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  const fallback = { width: 1440, height: 900 };
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    const st = {
      width: Math.max(1040, raw.width || fallback.width),
      height: Math.max(660, raw.height || fallback.height),
      maximized: !!raw.maximized,
    };
    if (Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
      // 屏幕数量/分辨率可能变过，确认这块区域还在可见范围内
      const visible = screen.getAllDisplays().some((d) => {
        const b = d.workArea;
        return raw.x < b.x + b.width - 80 && raw.x + st.width > b.x + 80
            && raw.y < b.y + b.height - 40 && raw.y + st.height > b.y + 40;
      });
      if (visible) { st.x = raw.x; st.y = raw.y; }
    }
    return st;
  } catch {
    return fallback;
  }
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(stateFile(), JSON.stringify({
      x: b.x, y: b.y, width: b.width, height: b.height,
      maximized: win.isMaximized(),
    }, null, 2));
  } catch { /* 写不进去就算了，不值得打断用户 */ }
}

// ─────────────────────────────────────────────────────────
// 单实例
// ─────────────────────────────────────────────────────────
let mainWindow = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

// 自定义协议必须在 ready 之前登记权限
protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
}]);

// ─────────────────────────────────────────────────────────
// 协议处理：把 app://xiaomo-lab/xxx 映射到 APP_ROOT/xxx
// ─────────────────────────────────────────────────────────
function registerAppProtocol() {
  protocol.handle(SCHEME, async (req) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url).pathname); }
    catch { return new Response('Bad Request', { status: 400 }); }

    if (!rel || rel === '/') rel = '/index.html';
    const filePath = path.join(APP_ROOT, rel.replace(/^[/\\]+/, ''));
    const outside = path.relative(APP_ROOT, filePath);
    if (outside.startsWith('..') || path.isAbsolute(outside)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const data = await fsp.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      return new Response(data, {
        status: 200,
        headers: {
          'content-type': MIME[ext] || 'application/octet-stream',
          'cache-control': IS_DEV ? 'no-store' : 'no-cache',
        },
      });
    } catch (err) {
      if (err && err.code === 'ENOTDIR') return new Response('Not Found', { status: 404 });
      if (err && err.code === 'ENOENT') return new Response('Not Found: ' + rel, { status: 404 });
      return new Response('Server Error', { status: 500 });
    }
  });
}

// ─────────────────────────────────────────────────────────
// 主窗口
// ─────────────────────────────────────────────────────────
function createWindow() {
  const st = loadWindowState();

  mainWindow = new BrowserWindow({
    width: st.width,
    height: st.height,
    x: st.x,
    y: st.y,
    minWidth: 1040,
    minHeight: 660,
    show: false,
    frame: false,              // 自绘标题栏：Win10 与 Win11 观感一致
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0f0d' : '#f4f8f1',
    title: '小墨实验室',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,   // 后台时实验仍要按真实时间推进
    },
  });

  if (st.maximized) mainWindow.maximize();

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  // ── 把窗口状态推给渲染进程，好切换最大化/还原图标 ──
  const pushState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('win:state', {
      maximized: mainWindow.isMaximized(),
      fullScreen: mainWindow.isFullScreen(),
    });
  };
  for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore']) {
    mainWindow.on(ev, pushState);
  }

  // ── 防抖保存窗口状态 ──
  let timer = null;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => saveWindowState(mainWindow), 400);
  };
  mainWindow.on('resize', schedule);
  mainWindow.on('move', schedule);
  mainWindow.on('close', () => saveWindowState(mainWindow));
  mainWindow.on('closed', () => { mainWindow = null; });

  // ── 外链一律交给系统浏览器，窗口本身只装自家页面 ──
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`${SCHEME}://`)) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[桌面版] 渲染进程退出：', details.reason);
  });

  mainWindow.loadURL(APP_URL);

  // ── 自检：--selftest 时把渲染结果打到标准输出再退出 ──
  // 无人值守环境下确认「app:// 协议通、前端起来了、窗口按钮挂上了」，
  // 免得只看到进程活着就以为一切正常。
  if (SELFTEST) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const probe = `(() => {
          const q = (s) => document.querySelector(s);
          let stats = null;
          try {
            stats = (window.xiaomo && window.xiaomo.host && window.xiaomo.host.stats)
              ? window.xiaomo.host.stats() : 'no-host';
          } catch (e) { stats = 'err:' + e.message; }
          return {
            title: document.title,
            url: location.href,
            theme: document.documentElement.dataset.theme,
            mode: document.documentElement.dataset.mode,
            desktopFlag: document.documentElement.dataset.desktop === '1',
            bridge: typeof window.xiaomoDesktop,
            canvas: !!q('#canvas'),
            winButtons: document.querySelectorAll('.wc-btn').length,
            slots: [...document.querySelectorAll('[data-slot]')].map(e => e.dataset.slot),
            paletteItems: document.querySelectorAll('.pitem').length,
            credit: q('.credit-badge') ? q('.credit-badge').textContent.trim() : null,
            status: q('#stCount') ? q('#stCount').textContent.trim() : null,
            themeDots: document.querySelectorAll('.theme-dot').length,
            orb: !!q('.fx-orb'),
            dotsWrapChildren: q('.theme-dots') ? q('.theme-dots').children.length : -1,
            stageFxHTML: q('.stage-fx') ? q('.stage-fx').innerHTML.slice(0, 260) : null,
            errors: window.__xiaomoErrors || [],
          };
        })()`;
        try {
          const r = await mainWindow.webContents.executeJavaScript(probe, true);
          console.log('SELFTEST_OK ' + JSON.stringify(r));
        } catch (e) {
          console.log('SELFTEST_FAIL ' + (e && e.message ? e.message : String(e)));
        }
        // --shot 时顺便存一张窗口截图，方便肉眼确认排版
        if (process.argv.includes('--shot')) {
          try {
            const img = await mainWindow.webContents.capturePage();
            const file = path.join(__dirname, 'preview.png');
            await fsp.writeFile(file, img.toPNG());
            console.log('SELFTEST_SHOT ' + file);
          } catch (e) {
            console.log('SELFTEST_SHOT_FAIL ' + (e && e.message ? e.message : String(e)));
          }
        }
        // 端到端验一次 IPC：按钮渲染出来 != 按钮真能驱动窗口
        try {
          const ipc = await mainWindow.webContents.executeJavaScript(`(async () => {
            const D = window.xiaomoDesktop;
            const before = await D.isMaximized();
            const on = await D.toggleMaximize();
            const off = await D.toggleMaximize();
            return { before, on, off, sysTheme: await D.getSystemTheme() };
          })()`, true);
          const ok = ipc && ipc.on === true && ipc.off === false && ipc.before === false;
          console.log((ok ? 'SELFTEST_IPC_OK ' : 'SELFTEST_IPC_FAIL ') + JSON.stringify(ipc));
        } catch (e) {
          console.log('SELFTEST_IPC_FAIL ' + (e && e.message ? e.message : String(e)));
        }
        // 端到端验一次器材包：纯数据派生是不是真的落到注册表里
        try {
          const pk = await mainWindow.webContents.executeJavaScript(`(() => {
            const P = window.xiaomo && window.xiaomo.services && window.xiaomo.services.packs;
            if (!P) return { ok: false, error: '没有器材包服务' };
            const reg = window.xiaomo.host.registry('equipment');
            const before = reg.size;

            // ① 好包：应当装上，参数被覆盖，原件数 +1
            const good = P.install({
              format: 'xiaomo.equipment.pack', version: 1,
              id: 'selftest.pack', name: '自检包',
              equipment: [
                { type: 'selftest-battery', proto: 'battery', name: '自检电池',
                  defaults: { emf: 12, internalR: 0.8 } }
              ]
            }, { silent: true });
            const d = reg.get('selftest-battery');
            const goodInfo = {
              installed: good.ok,
              emf: d && d.defaults ? d.defaults.emf : null,
              packTag: d ? d.pack : null,
              size: reg.size,
            };

            // ② 坏包：引用不存在的原型，必须被整包拒绝，且不留下半套器材
            const beforeBad = reg.size;
            const bad = P.install({
              format: 'xiaomo.equipment.pack', version: 1,
              id: 'selftest.bad', name: '坏包',
              equipment: [{ type: 'selftest-bad', proto: 'no-such-proto', name: '坏器材' }]
            }, { silent: true });
            const afterBad = reg.size;   // 必须在卸载好包之前取，否则比的是卸载后的数

            P.uninstall('selftest.pack');
            return {
              good: goodInfo,
              bad: { rejected: bad.ok === false, error: bad.error || null,
                     leaked: afterBad !== beforeBad },
              before,
              afterUninstall: reg.size,
            };
          })()`, true);
          const pkOk = pk && pk.good && pk.good.installed === true && pk.good.emf === 12
            && pk.good.size === pk.before + 1
            && pk.bad && pk.bad.rejected === true && pk.bad.leaked === false
            && pk.afterUninstall === pk.before;
          console.log((pkOk ? 'SELFTEST_PACK_OK ' : 'SELFTEST_PACK_FAIL ') + JSON.stringify(pk));
        } catch (e) {
          console.log('SELFTEST_PACK_FAIL ' + (e && e.message ? e.message : String(e)));
        }
        app.exit(0);
      }, 4000);
    });
  }
}

// ─────────────────────────────────────────────────────────
// 应用菜单（中文）
// ─────────────────────────────────────────────────────────
function sendCommand(cmd, payload) {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (win && !win.isDestroyed()) win.webContents.send('menu:command', cmd, payload);
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '新建实验', accelerator: 'CmdOrCtrl+N', click: () => sendCommand('scene:new') },
        { label: '打开实验…', accelerator: 'CmdOrCtrl+O', click: () => sendCommand('scene:open') },
        { label: '保存实验', accelerator: 'CmdOrCtrl+S', click: () => sendCommand('scene:save') },
        { type: 'separator' },
        { label: '导出图片…', accelerator: 'CmdOrCtrl+Shift+E', click: () => sendCommand('scene:png') },
        { type: 'separator' },
        { label: '导入器材包…', click: () => sendCommand('pack:import') },
        { label: '管理插件…', click: () => sendCommand('ui:plugins') },
        { type: 'separator' },
        { label: '退出', click: () => app.quit() },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '切换浅色 / 深色', accelerator: 'CmdOrCtrl+D', click: () => sendCommand('theme:toggle') },
        { label: '换一个主题', accelerator: 'CmdOrCtrl+Shift+D', click: () => sendCommand('theme:next') },
        { type: 'separator' },
        { label: '重新载入', role: 'reload' },
        { label: '开发者工具', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
      ],
    },
    {
      label: '实验',
      submenu: [
        { label: '运行 / 暂停', accelerator: 'F5', click: () => sendCommand('sim:toggle') },
        { label: '重置实验', accelerator: 'CmdOrCtrl+Shift+R', click: () => sendCommand('sim:reset') },
        { label: '清空器材', click: () => sendCommand('sim:clear') },
        { type: 'separator' },
        { label: '选择工具', accelerator: 'V', click: () => sendCommand('tool:select') },
        { label: '连线工具', accelerator: 'W', click: () => sendCommand('tool:wire') },
        { label: '倾倒工具', accelerator: 'P', click: () => sendCommand('tool:pour') },
        { label: '删除工具', accelerator: 'X', click: () => sendCommand('tool:erase') },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '操作提示', click: () => sendCommand('ui:hint') },
        { label: '关于小墨实验室', click: () => sendCommand('ui:about') },
        {
          label: '打开项目主页',
          click: () => shell.openExternal('https://github.com/'),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─────────────────────────────────────────────────────────
// IPC
// ─────────────────────────────────────────────────────────
function winOf(e) { return BrowserWindow.fromWebContents(e.sender) || mainWindow; }

function registerIpc() {
  // 窗口控制
  ipcMain.on('win:minimize', (e) => winOf(e)?.minimize());
  ipcMain.on('win:close', (e) => winOf(e)?.close());
  ipcMain.handle('win:is-maximized', (e) => !!winOf(e)?.isMaximized());
  ipcMain.handle('win:toggle-maximize', (e) => {
    const w = winOf(e);
    if (!w) return false;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
    return w.isMaximized();
  });

  // 场景文件
  ipcMain.handle('file:save-scene', async (e, { json, suggestedName } = {}) => {
    const w = winOf(e);
    const { canceled, filePath } = await dialog.showSaveDialog(w, {
      title: '保存实验场景',
      defaultPath: suggestedName || '小墨实验.xiaomo',
      filters: [
        { name: '小墨实验场景', extensions: ['xiaomo'] },
        { name: 'JSON 文件', extensions: ['json'] },
      ],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      await fsp.writeFile(filePath, json ?? '', 'utf8');
      return { ok: true, filePath, name: path.basename(filePath) };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('file:open-scene', async (e) => {
    const w = winOf(e);
    const { canceled, filePaths } = await dialog.showOpenDialog(w, {
      title: '打开实验场景',
      properties: ['openFile'],
      filters: [
        { name: '小墨实验场景', extensions: ['xiaomo', 'json'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    });
    if (canceled || !filePaths || !filePaths[0]) return { ok: false, canceled: true };
    try {
      const json = await fsp.readFile(filePaths[0], 'utf8');
      return { ok: true, filePath: filePaths[0], name: path.basename(filePaths[0]), json };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('file:export-png', async (e, { dataUrl, suggestedName } = {}) => {
    const w = winOf(e);
    const { canceled, filePath } = await dialog.showSaveDialog(w, {
      title: '导出实验台图片',
      defaultPath: suggestedName || '小墨实验台.png',
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      const b64 = String(dataUrl || '').replace(/^data:image\/png;base64,/, '');
      await fsp.writeFile(filePath, Buffer.from(b64, 'base64'));
      return { ok: true, filePath, name: path.basename(filePath) };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // 器材包
  ipcMain.handle('pack:import', async (e) => {
    const w = winOf(e);
    const { canceled, filePaths } = await dialog.showOpenDialog(w, {
      title: '导入器材包',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '小墨器材包', extensions: ['xiaomo-pack', 'json'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    });
    if (canceled || !filePaths || !filePaths.length) return { ok: false, canceled: true };
    try {
      const packs = [];
      for (const p of filePaths) {
        packs.push({ name: path.basename(p), text: await fsp.readFile(p, 'utf8') });
      }
      return { ok: true, packs };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('pack:export', async (e, { json, suggestedName } = {}) => {
    const w = winOf(e);
    const { canceled, filePath } = await dialog.showSaveDialog(w, {
      title: '导出器材包',
      defaultPath: suggestedName || '我的器材包.xiaomo-pack',
      filters: [{ name: '小墨器材包', extensions: ['xiaomo-pack'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      await fsp.writeFile(filePath, json ?? '', 'utf8');
      return { ok: true, filePath, name: path.basename(filePath) };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // 其它
  ipcMain.handle('shell:open-external', (_e, url) => {
    if (/^https?:\/\//i.test(String(url))) shell.openExternal(String(url));
    return true;
  });
  ipcMain.handle('system:theme-get', () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'));
}

// ─────────────────────────────────────────────────────────
// 生命周期
// ─────────────────────────────────────────────────────────
app.setAppUserModelId('com.xiaomo.lab');

app.whenReady().then(() => {
  registerAppProtocol();
  registerIpc();
  buildMenu();
  createWindow();

  nativeTheme.on('updated', () => {
    const mode = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('system:theme', mode);
      w.setBackgroundColor(mode === 'dark' ? '#0b0f0d' : '#f4f8f1');
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
