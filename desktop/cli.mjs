#!/usr/bin/env node
// ══════════════════════════════════════════════════════════
// 小墨实验室 · 桌面版启动器（npm bin 入口）
//
//   xiaomo-lab              启动窗口
//   xiaomo-lab --dev        带开发者工具启动
//   npx xiaomo-lab          免安装试一下
//
// 这里只做两件事：找到 Electron 的可执行文件、把主进程拉起来。
// 前端资源路径由 main.js 自己解析（它从 __dirname 往上一级找 index.html），
// 所以本文件不参与任何路径拼接规则，包装在全局、npx 缓存还是仓库里都能跑。
// ══════════════════════════════════════════════════════════

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');   // 仓库根 / npm 安装后的包根
const require = createRequire(import.meta.url);
const MAIN = path.join(__dirname, 'main.js');

const ARGS = process.argv.slice(2);

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch { return '0.0.0'; }
}

// ── --help / --version：只为看一眼用法，不该弹出一个窗口 ──
if (ARGS.includes('-h') || ARGS.includes('--help')) {
  console.log([
    '',
    '小墨实验室 · 桌面版',
    '',
    '  xiaomo-lab            启动窗口',
    '  xiaomo-lab --dev      带开发者工具启动',
    '  npx xiaomo-lab        免安装试一下',
    '',
    '其余参数原样交给 Electron，例如 --selftest（自检并把结果打到标准输出后退出）。',
    '前端跑在 app://xiaomo-lab/ 下，资源取自包内的 index.html / src / styles。',
    '',
  ].join('\n'));
  process.exit(0);
}
if (ARGS.includes('-v') || ARGS.includes('--version')) {
  console.log(readVersion());
  process.exit(0);
}

// ─────────────────────────────────────────────────────────
// 找 Electron 可执行文件
//   ① 正规途径：electron 包自己导出二进制路径（依赖装在包根、
//      desktop/ 下、还是被 npm 提升到上层，require 都会往上找）
//   ② 兜底：自己拼各平台的二进制路径
// ─────────────────────────────────────────────────────────
function candidates() {
  const bins = [
    ['dist', 'electron.exe'],                        // Windows
    ['dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'],  // macOS
    ['dist', 'electron'],                            // Linux
  ];
  const dirs = [
    path.join(PKG_ROOT, 'node_modules', 'electron'),
    path.join(__dirname, 'node_modules', 'electron'),
  ];
  return dirs.flatMap((dir) => bins.map((parts) => path.join(dir, ...parts)));
}

function resolveElectron() {
  try {
    const bin = require('electron');
    if (typeof bin === 'string' && fs.existsSync(bin)) return bin;
  } catch { /* 没装或装了一半，走兜底 */ }
  for (const bin of candidates()) {
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

const electron = resolveElectron();

if (!electron) {
  console.error('');
  console.error('  没有找到 Electron，窗口起不来。先装一次依赖：');
  console.error('');
  console.error('      npm install                # 在包根（xiaomo-lab 包安装后的目录）');
  console.error('      cd desktop && npm install  # 或者只在本地开发时');
  console.error('');
  console.error('  国内网络下载 Electron 二进制经常超时，用 npmmirror 镜像：');
  console.error('');
  console.error('      npm config set electron_mirror https://registry.npmmirror.com/-/binary/electron/');
  console.error('      或把 desktop/.npmrc 复制到包根后重跑（里面已经配好镜像）');
  console.error('');
  console.error('  PowerShell 若提示「禁止运行脚本」，把 npm 换成 npm.cmd。');
  console.error('  找过这些位置：');
  for (const bin of candidates()) console.error('      ' + bin);
  console.error('');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────
// 启动
//   把「包根」交给 Electron，让它读根 package.json 的 main，
//   这样应用名 / 版本号 / 用户数据目录（%APPDATA%\小墨实验室）
//   不管从哪儿启动都一致。根 package.json 缺 main 时才点名主进程文件。
// ─────────────────────────────────────────────────────────
function appEntry() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
    if (pkg && pkg.main && fs.existsSync(path.resolve(PKG_ROOT, pkg.main))) return PKG_ROOT;
  } catch { /* 没有可用的根 package.json，直接点名 */ }
  return MAIN;
}

const child = spawn(electron, [appEntry(), ...ARGS], {
  stdio: 'inherit',
  windowsHide: false,
});

child.on('close', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error('启动失败：' + err.message);
  process.exit(1);
});

// Ctrl+C 时把窗口一起带走，别留孤儿进程
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { child.kill(); } catch { /* 已经退了 */ } });
}
