#!/usr/bin/env node
// ══════════════════════════════════════════════════════════
// 小墨实验室 —— WebDAV 定期备份守护进程
//
// 每隔一段时间调用一次 sync-webdav.ps1，把项目文件镜像到 WebDAV。
// 每次都会写日志到 tools/backup.log，方便回看有没有漏传。
//
// 用法：
//   node tools/backup-daemon.mjs                 # 每 10 分钟一次
//   node tools/backup-daemon.mjs --every=5       # 每 5 分钟一次
//   node tools/backup-daemon.mjs --once          # 只跑一次就退出
//   node tools/backup-daemon.mjs --full          # 强制全量重传
//   node tools/backup-daemon.mjs --once --full
// ══════════════════════════════════════════════════════════

import { spawn } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SYNC = path.join(__dirname, 'sync-webdav.ps1');
const LOG = path.join(__dirname, 'backup.log');

const argv = process.argv.slice(2);
const once = argv.includes('--once');
const full = argv.includes('--full');
const everyArg = argv.find((a) => a.startsWith('--every='));
const everyMin = everyArg
  ? Math.max(1, Number(everyArg.slice('--every='.length)) || 10)
  : 10;

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

async function log(line) {
  const s = `[${stamp()}] ${line}`;
  process.stdout.write(s + '\n');
  try { await appendFile(LOG, s + '\n', 'utf8'); } catch { /* 日志写不了不影响备份 */ }
}

function runSync() {
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', SYNC,
      ...(full ? ['-Full'] : []),
    ], { cwd: ROOT, windowsHide: true });

    let out = '';
    let err = '';
    ps.stdout.on('data', (d) => { out += d.toString(); });
    ps.stderr.on('data', (d) => { err += d.toString(); });
    ps.on('error', (e) => resolve({ code: -1, out: '', err: String(e.message) }));
    ps.on('close', (code) => resolve({ code, out, err }));
  });
}

/** 从脚本输出里挑出「同步完成: N 个文件, X KB」这行 */
function summarize(out) {
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const done = lines.find((l) => l.includes('同步完成') || l.includes('同步结束'));
  const failed = lines.filter((l) => l.includes('[FAIL]'));
  return { done: done || '', failed };
}

async function tick(n) {
  await log(`第 ${n} 次备份开始…`);
  const t0 = Date.now();
  const { code, out, err } = await runSync();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const { done, failed } = summarize(out);

  if (code === 0) {
    await log(`备份完成（${secs}s）${done ? ' · ' + done.replace(/\s+/g, ' ') : ''}`);
  } else {
    await log(`备份返回码 ${code}（${secs}s）${err ? ' · ' + err.split(/\r?\n/)[0] : ''}`);
    if (failed.length) await log(`  失败 ${failed.length} 个：${failed.slice(0, 5).join(' | ')}`);
  }
  return code;
}

async function main() {
  await log(`备份守护启动：每 ${everyMin} 分钟一次${full ? '（全量）' : ''}，日志 ${LOG}`);

  let n = 1;
  await tick(n);

  if (once) {
    await log('--once 已指定，退出。');
    return;
  }

  const ms = everyMin * 60 * 1000;
  // 用递归 setTimeout 而不是 setInterval：
  // 万一某次同步跑得比间隔还久，也不会堆积成并发上传。
  const loop = async () => {
    setTimeout(async () => {
      n += 1;
      await tick(n);
      loop();
    }, ms);
  };
  loop();

  const bye = async () => { await log('收到退出信号，停止备份。'); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

main().catch(async (e) => {
  await log('守护进程异常退出：' + (e && e.message ? e.message : String(e)));
  process.exit(1);
});
