// ══════════════════════════════════════════════════════════
// 小墨实验室 · 桌面版 · 预加载桥
//
// 渲染进程是纯网页（和浏览器版同一份代码），这里只把少量
// 桌面能力挂到 window.xiaomoDesktop 上。前端检测到这个对象
// 才显示窗口按钮、走原生对话框，浏览器版完全不受影响。
//
// 安全：contextIsolation 开、nodeIntegration 关，
// 渲染进程拿不到 require，只能调用下面这些白名单方法。
// ══════════════════════════════════════════════════════════

const { contextBridge, ipcRenderer } = require('electron');

/** 订阅一个 ipc 频道，返回取消订阅函数 */
function on(channel, fn) {
  const handler = (_e, ...args) => fn(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('xiaomoDesktop', {
  isDesktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },

  // ── 窗口控制 ──
  minimize: () => ipcRenderer.send('win:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('win:toggle-maximize'),
  close: () => ipcRenderer.send('win:close'),
  isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
  onWindowState: (fn) => on('win:state', fn),

  // ── 应用菜单指令 ──
  onMenu: (fn) => on('menu:command', fn),

  // ── 文件 ──
  saveScene: (json, suggestedName) =>
    ipcRenderer.invoke('file:save-scene', { json, suggestedName }),
  openScene: () => ipcRenderer.invoke('file:open-scene'),
  exportPng: (dataUrl, suggestedName) =>
    ipcRenderer.invoke('file:export-png', { dataUrl, suggestedName }),

  // ── 器材包 ──
  importPack: () => ipcRenderer.invoke('pack:import'),
  exportPack: (json, suggestedName) =>
    ipcRenderer.invoke('pack:export', { json, suggestedName }),

  // ── 其它 ──
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  onSystemTheme: (fn) => on('system:theme', fn),
  getSystemTheme: () => ipcRenderer.invoke('system:theme-get'),
  pathForFile: (file) => {
    try { return require('electron').webUtils.getPathForFile(file); }
    catch { return null; }
  },
});
