// 桌面版的调试用静态服务器：不想开 Electron 窗口时，
// 用 `npm run serve` 起它，浏览器打开同一份前端代码。
//
// 生产路径不走这里 —— Electron 主进程用 app:// 协议自己供给文件。

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 7374);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel === '/' || rel === '') rel = '/index.html';

    const file = path.join(ROOT, rel.replace(/^\/+/, ''));
    const outside = path.relative(ROOT, file);
    if (outside.startsWith('..') || path.isAbsolute(outside)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const info = await stat(file);
    if (info.isDirectory()) { res.writeHead(404).end('Not Found'); return; }

    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not Found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`小墨实验室 桌面版调试服务器：http://127.0.0.1:${PORT}/`);
  console.log(`前端根目录：${ROOT}`);
});
