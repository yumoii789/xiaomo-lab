// 小墨实验室 —— 零依赖静态服务器
// 用法: node server.mjs [port]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 7373);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
};

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const target = normalize(join(root, decoded));
  if (!target.startsWith(root + sep) && target !== root) return null;
  return target;
}

const server = createServer(async (req, res) => {
  try {
    let path = safeJoin(ROOT, req.url === '/' ? '/index.html' : req.url);
    if (!path) { res.writeHead(403).end('403'); return; }

    let info = await stat(path).catch(() => null);
    if (info?.isDirectory()) {
      path = join(path, 'index.html');
      info = await stat(path).catch(() => null);
    }
    if (!info) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 未找到: ' + req.url); return; }

    res.writeHead(200, {
      'content-type': MIME[extname(path).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-length': info.size,
    });
    createReadStream(path).pipe(res);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('500 ' + err.message);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log('');
  console.log('  ⚗️  小墨实验室已启动');
  console.log('  ➜  ' + url);
  console.log('');
  console.log('  按 Ctrl+C 停止');
  console.log('');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 被占用，试试: node server.mjs ${PORT + 1}`);
  } else {
    console.error(e);
  }
  process.exit(1);
});
