// ══════════════════════════════════════════════════════════
// 插件市场内核 —— 目录客户端 + 安装引擎
//
// 为什么目录格式一字不改地沿用 DSH 的 catalog-source / catalog-provider-page：
//   DSH 的「目录提供方契约」是一套公开、已文档化的第三方接入协议
//   （路径 A：任何人在自己的 origin 上发布两个匿名 HTTPS JSON 即可接入，无需审批）。
//   字段名照抄，于是**同一个目录源既能被 DSH 读、也能被小墨读** ——
//   社区作者写一次就能两边上架。这是本方案相对自己发明格式的核心优势。
//
// 为什么浏览器需要的东西（单文件 ESM 入口、sha256、kind）放在**旁挂文档**
// xiaomo-extensions.json，而不是塞进 provider page 的 item 里：
//   DSH 契约要求 strict schema、**拒绝 object 的未知字段**
//   （契约 §安全要求·数据与 renderer 边界 / §已验证测试矩阵：含未知字段 → 拒绝对应 manifest/request/snapshot）。
//   往 item 里加 `xiaomo` 会让 DSH 整页拒收，那正好毁掉上面那个唯一优势。
//   所以默认目录源走旁挂文档；item 级 `xiaomo` 只作为「非标准来源」的兼容接纳口保留
//   （两者都在时以 item 级为准：它离条目更近，见 resolveEntry）。
//
// 为什么把「拉字节 → 校验哈希 → Blob → import()」这条链放内核而不是界面：
//   它是可被 Node 直接 import 的纯逻辑，坏数据的拒绝路径因此能用脚本逐条断言，
//   不必靠浏览器点一遍才知道校验有没有生效。
//
// 本文件零依赖、不碰 DOM。唯一的副作用是给事件总线补一条通知（见 forgetPlugin）。
// ══════════════════════════════════════════════════════════

import { bus } from './bus.js';

/** 本地状态键：来源列表 + 已装记录。与 DSH 的「来源设置与缓存分开持久化」同一条原则。 */
export const MARKET_KEY = 'xiaomo.market.v1';

/** 与 main.js 的 VERSION 对齐：用来判定 xiaomo.minHost 是否满足。 */
export const HOST_VERSION = '2.0.0';

export const MANIFEST_VERSION = '1.0.0';
export const PAGE_SCHEMA_VERSION = '1.0.0';
export const EXTENSIONS_FORMAT = 'xiaomo.market.extensions';
export const EXTENSIONS_VERSION = 1;

/** 旁挂文档的固定文件名：与目录端点同目录，由端点 URL 推导。 */
export const EXTENSIONS_NAME = 'xiaomo-extensions.json';

/** 契约里的 Schema 上限：一页最多 200 条；每个 JSON response 最多 2 MiB。 */
export const MAX_PAGE_ITEMS = 200;
export const MAX_JSON_BYTES = 2 * 1024 * 1024;
/** 单文件插件上限。社区插件必须单文件零依赖，给 512 KiB 已经很宽松。 */
export const MAX_PLUGIN_BYTES = 512 * 1024;

/** connect/first-byte/total 三个 deadline 在浏览器里只能合成一个总超时。 */
export const FETCH_TIMEOUT_MS = 20000;

export const PLUGIN_KINDS = Object.freeze(['ui', 'system', 'equipment', 'theme', 'rules', 'chemistry', 'content', 'misc']);

/**
 * 契约硬规则里被点名禁止出现在 manifest / response 里的东西。
 * 未知字段本来就会被 strict 校验拒掉，这里是第二道闸：
 * 防的是「将来某天有人把一个本该拒绝的键加进白名单」时静默放行代码。
 */
const FORBIDDEN_KEYS = Object.freeze([
  'script', 'javascript', 'eval', 'code', 'cmd', 'command', 'installcmd', 'installcommand',
  'adapter', 'adaptercode', 'mapping', 'mappings', 'credential', 'credentials',
  'password', 'token', 'apikey', 'html', 'iframe', 'onload', 'onerror',
]);

export class MarketError extends Error {
  /** @param {string} code 机器可读的错误码（界面与探针按它断言，不看文案） */
  constructor(code, message, detail) {
    super(message);
    this.name = 'MarketError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

// ─────────────────────────────────────────────────────────
// 基础校验工具
// ─────────────────────────────────────────────────────────

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function expectObj(v, where) {
  if (!isObj(v)) throw new MarketError('bad-type', `${where} 应该是一个对象`);
  return v;
}

/** strict：只允许白名单里的键。契约要求拒绝未知字段，这里把「拒绝」做成默认。 */
function expectKeys(obj, allowed, where) {
  for (const k of Object.keys(obj)) {
    const low = k.toLowerCase();
    if (FORBIDDEN_KEYS.includes(low)) {
      throw new MarketError('code-not-allowed', `${where} 出现契约禁止的字段「${k}」：目录里不允许携带代码、命令或凭据`);
    }
    if (!allowed.includes(k)) {
      throw new MarketError('unknown-field', `${where} 出现未知字段「${k}」（目录采用 strict schema，未知字段一律拒绝）`);
    }
  }
  return obj;
}

function expectStr(v, where, { min = 1, max = Infinity, pattern = null, optional = false } = {}) {
  if (v === undefined || v === null) {
    if (optional) return undefined;
    throw new MarketError('bad-type', `${where} 缺失`);
  }
  if (typeof v !== 'string') throw new MarketError('bad-type', `${where} 应该是字符串`);
  if (v.length < min) throw new MarketError('bad-value', `${where} 太短（至少 ${min} 个字符）`);
  if (v.length > max) throw new MarketError('bad-value', `${where} 太长（最多 ${max} 个字符）`);
  if (pattern && !pattern.test(v)) throw new MarketError('bad-value', `${where} 格式不合法：${JSON.stringify(v)}`);
  return v;
}

function expectInt(v, where, { min = 0, max = Infinity, optional = false } = {}) {
  if (v === undefined || v === null) {
    if (optional) return undefined;
    throw new MarketError('bad-type', `${where} 缺失`);
  }
  if (!Number.isInteger(v)) throw new MarketError('bad-type', `${where} 应该是整数`);
  if (v < min || v > max) throw new MarketError('bad-value', `${where} 超出范围 ${min}..${max}：${v}`);
  return v;
}

function expectStrArray(v, where, { max = 64, optional = true } = {}) {
  if (v === undefined || v === null) {
    if (optional) return undefined;
    throw new MarketError('bad-type', `${where} 缺失`);
  }
  if (!Array.isArray(v)) throw new MarketError('bad-type', `${where} 应该是数组`);
  if (v.length > max) throw new MarketError('bad-value', `${where} 条目过多（最多 ${max}）`);
  for (const x of v) {
    if (typeof x !== 'string' || !x) throw new MarketError('bad-type', `${where} 里有非字符串条目`);
  }
  return v;
}

// ─────────────────────────────────────────────────────────
// URL 策略
//
// 只收 HTTPS。唯一的例外是回环地址上的 http —— 契约本身允许
// 「明确、可见且生产 build 不存在的本地开发 override」（§安全要求·网络边界），
// 而本机把 github.io 解析到了 127.0.0.1（见 plans/02-发布与环境.md），
// 不给这条例外就根本无法在本地把目录链路跑通。
// 例外只对 127.0.0.1 / ::1 / localhost 生效，且结果会被标记 dev=true 在界面上如实显示。
// ─────────────────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '0.0.0.0']);

export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host || '').toLowerCase().replace(/^\[|\]$/g, ''));
}

/**
 * 「包内来源」判定 —— 只有它拿得到 assertAllowedUrl 的 allowPackaged。
 *
 * 两个条件同时成立才算：来源记录是**内置登记的**（bundled），而且地址是 `app:`。
 * 前者排除了用户手输的地址（addSource 仍只收 HTTPS/回环），后者排除了「内置但指向远端」的形态。
 * 桌面版的默认来源正是这样一条记录（见 defaultManifestUrl ③ 与
 * market/catalog-source.local.json 的 endpoint）。
 */
export function isPackagedSource(rec) {
  return !!(rec && rec.bundled && /^app:/i.test(String(rec.url || '')));
}

/**
 * 校验一个目录/插件 URL 是否可以使用，返回 { url, href, dev }。
 * 拒绝：非 https（回环开发地址除外）、带用户名密码、带 fragment、非标准 scheme。
 * 唯一的具名例外是 allowPackaged：桌面版的**包内**来源（`app://`，由宿主自己的协议从磁盘供给、
 * 一个字节都不走网络）需要它。默认 false —— 用户手输的地址走的仍是这条严格路径，
 * 「只收 HTTPS + 回环开发例外」这条信任边界没有被整体放宽（market-selftest 有断言钉着它）。
 */
export function assertAllowedUrl(raw, where, { allowQuery = false, allowLoopback = true, allowPackaged = false } = {}) {
  expectStr(raw, where, { max: 2048 });
  let u;
  try { u = new URL(raw); } catch { throw new MarketError('bad-url', `${where} 不是合法 URL：${raw}`); }

  const isHttps = u.protocol === 'https:';
  const dev = !isHttps && u.protocol === 'http:' && allowLoopback && isLoopbackHost(u.hostname);
  const packaged = allowPackaged && u.protocol === 'app:';
  if (!isHttps && !dev && !packaged) {
    throw new MarketError('insecure-url', `${where} 必须是 HTTPS 地址（只收 HTTPS；http 仅允许本机回环用于开发）：${raw}`);
  }
  if (u.username || u.password) throw new MarketError('bad-url', `${where} 不允许携带用户名或密码：${raw}`);
  if (u.hash) throw new MarketError('bad-url', `${where} 不允许带 fragment：${raw}`);
  if (!allowQuery && u.search) throw new MarketError('bad-url', `${where} 不允许自带 query 参数：${raw}`);
  if (isHttps && u.port && u.port !== '443') throw new MarketError('bad-url', `${where} 必须使用标准端口 443：${raw}`);
  return { url: u, href: u.href, dev };
}

/** 目录端点的路径必须以 /v1/plugins 结尾 —— 契约的 pattern 就是这么写的。 */
const ENDPOINT_PATH = /\/v1\/plugins$/;

/** 由目录端点推导旁挂扩展文档的地址（同目录下的固定文件名）。 */
export function extensionsUrlFor(endpoint) {
  return new URL(EXTENSIONS_NAME, endpoint).href;
}

// ─────────────────────────────────────────────────────────
// 第一层：来源 manifest（DSH catalog-source.schema.json 的形状，字段名一字不改）
// ─────────────────────────────────────────────────────────

const PROVIDER_ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const QUERY_FEATURES = Object.freeze(['q', 'category', 'capability', 'cursor', 'limit', 'sort', 'locale']);
const SORTS = Object.freeze(['relevance', 'updated', 'name', 'downloads']);

/**
 * 解析并校验一个来源 manifest。
 * @param {object} json 已 JSON.parse 的对象
 * @param {{allowLoopback?: boolean, allowPackaged?: boolean}} [opts]
 * @returns 冻结的规范化 manifest（额外带 dev 标记，界面据此显示「本地开发来源」）
 */
export function parseSource(json, opts = {}) {
  const allowLoopback = opts.allowLoopback !== false;
  const allowPackaged = opts.allowPackaged === true;
  expectObj(json, '来源 manifest');
  expectKeys(json, ['manifestVersion', 'providerId', 'name', 'description', 'homepage', 'attribution', 'transport', 'query'], '来源 manifest');

  if (json.manifestVersion !== MANIFEST_VERSION) {
    throw new MarketError('bad-version', `不支持的 manifestVersion「${json.manifestVersion}」（本实现只认 ${MANIFEST_VERSION}）`);
  }
  const providerId = expectStr(json.providerId, 'providerId', { min: 3, max: 128, pattern: PROVIDER_ID_RE });
  const name = expectStr(json.name, 'name', { max: 120 });
  const description = expectStr(json.description, 'description', { max: 500, optional: true });

  const homepage = json.homepage === undefined ? undefined
    : assertAllowedUrl(json.homepage, 'homepage', { allowLoopback, allowPackaged }).href;

  expectObj(json.attribution, 'attribution');
  expectKeys(json.attribution, ['name', 'url', 'notice'], 'attribution');
  const attribution = {
    name: expectStr(json.attribution.name, 'attribution.name', { max: 120 }),
    url: assertAllowedUrl(json.attribution.url, 'attribution.url', { allowLoopback, allowPackaged }).href,
    notice: expectStr(json.attribution.notice, 'attribution.notice', { max: 500, optional: true }),
  };

  expectObj(json.transport, 'transport');
  expectKeys(json.transport, ['kind', 'endpoint', 'method'], 'transport');
  if (json.transport.kind !== 'https-json') {
    throw new MarketError('bad-transport', `transport.kind 只支持 "https-json"，收到「${json.transport.kind}」`);
  }
  if (json.transport.method !== 'GET') {
    throw new MarketError('bad-transport', `transport.method 只支持 "GET"，收到「${json.transport.method}」`);
  }
  const ep = assertAllowedUrl(json.transport.endpoint, 'transport.endpoint', { allowLoopback, allowPackaged });
  if (!ENDPOINT_PATH.test(ep.url.pathname)) {
    throw new MarketError('bad-endpoint', `transport.endpoint 的路径必须以 /v1/plugins 结尾（契约 pattern）：${ep.href}`);
  }

  expectObj(json.query, 'query');
  expectKeys(json.query, ['supported', 'defaultLimit', 'maxLimit', 'sorts'], 'query');
  const supported = expectStrArray(json.query.supported, 'query.supported', { max: 7, optional: false });
  for (const f of supported) {
    if (!QUERY_FEATURES.includes(f)) throw new MarketError('bad-value', `query.supported 里有契约未定义的特性「${f}」`);
  }
  const defaultLimit = expectInt(json.query.defaultLimit, 'query.defaultLimit', { min: 1, max: 200 });
  const maxLimit = expectInt(json.query.maxLimit, 'query.maxLimit', { min: 1, max: 200 });
  // 字段间关系也要校验：schema 管不了 defaultLimit <= maxLimit
  if (defaultLimit > maxLimit) {
    throw new MarketError('bad-value', `query.defaultLimit (${defaultLimit}) 不能大于 maxLimit (${maxLimit})`);
  }
  const sorts = expectStrArray(json.query.sorts, 'query.sorts', { max: 4, optional: false });
  for (const s of sorts) {
    if (!SORTS.includes(s)) throw new MarketError('bad-value', `query.sorts 里有契约未定义的排序「${s}」`);
  }
  if (supported.includes('sort') && sorts.length === 0) {
    throw new MarketError('bad-value', '声明支持 sort 时 query.sorts 不能为空');
  }

  return Object.freeze({
    manifestVersion: MANIFEST_VERSION,
    providerId,
    name,
    description,
    homepage,
    attribution: Object.freeze(attribution),
    transport: Object.freeze({ kind: 'https-json', endpoint: ep.href, method: 'GET' }),
    query: Object.freeze({ supported: Object.freeze(supported.slice()), defaultLimit, maxLimit, sorts: Object.freeze(sorts.slice()) }),
    extensionsUrl: extensionsUrlFor(ep.url),
    dev: ep.dev,
  });
}

// ─────────────────────────────────────────────────────────
// 第三层：provider page（DSH catalog-provider-page.schema.json 的形状）
//
// item 上只额外接纳一个键：`xiaomo`（命名空间扩展）。
// 这是为了让「非标准来源」也能声明安装信息；默认目录源不用它，走旁挂文档。
// ─────────────────────────────────────────────────────────

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;
const CATEGORY_RE = /^[a-z0-9][a-z0-9._:-]*$/;
const CAPABILITY_RE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;

const ITEM_KEYS = Object.freeze([
  'id', 'name', 'displayName', 'summary', 'description', 'homepage', 'latestVersion', 'license',
  'categories', 'keywords', 'repository', 'installSource', 'package', 'publisher', 'media',
  'capabilities', 'compatibility', 'updatedAt', 'xiaomo',
]);

function parseItem(raw, idx, opts) {
  const where = `items[${idx}]`;
  expectObj(raw, where);
  expectKeys(raw, ITEM_KEYS, where);

  const item = {
    id: expectStr(raw.id, `${where}.id`, { max: 160, pattern: ID_RE }),
    name: expectStr(raw.name, `${where}.name`, { max: 160 }),
    displayName: expectStr(raw.displayName, `${where}.displayName`, { max: 120 }),
    summary: expectStr(raw.summary, `${where}.summary`, { max: 1000 }),
    description: expectStr(raw.description, `${where}.description`, { max: 5000, optional: true }),
    homepage: raw.homepage === undefined ? undefined : assertAllowedUrl(raw.homepage, `${where}.homepage`, opts).href,
    latestVersion: expectStr(raw.latestVersion, `${where}.latestVersion`, { max: 64, optional: true }),
    license: expectStr(raw.license, `${where}.license`, { max: 80, optional: true }),
    updatedAt: expectStr(raw.updatedAt, `${where}.updatedAt`, { max: 64, optional: true }),
  };

  if (raw.categories !== undefined) {
    const cats = expectStrArray(raw.categories, `${where}.categories`, { max: 32 });
    for (const c of cats) {
      if (!CATEGORY_RE.test(c)) throw new MarketError('bad-value', `${where}.categories 里的「${c}」不是合法分类标识`);
    }
    item.categories = Object.freeze(cats.slice());
  }
  if (raw.keywords !== undefined) item.keywords = Object.freeze(expectStrArray(raw.keywords, `${where}.keywords`, { max: 64 }).slice());

  if (raw.repository !== undefined) {
    expectObj(raw.repository, `${where}.repository`);
    expectKeys(raw.repository, ['url', 'subdirectory'], `${where}.repository`);
    item.repository = Object.freeze({
      url: assertAllowedUrl(raw.repository.url, `${where}.repository.url`, opts).href,
      subdirectory: expectStr(raw.repository.subdirectory, `${where}.repository.subdirectory`, { max: 240, optional: true }),
    });
  }
  if (raw.package !== undefined) {
    expectObj(raw.package, `${where}.package`);
    expectKeys(raw.package, ['registry', 'name'], `${where}.package`);
    if (raw.package.registry !== 'npm') throw new MarketError('bad-value', `${where}.package.registry 只支持 "npm"`);
    item.package = Object.freeze({ registry: 'npm', name: expectStr(raw.package.name, `${where}.package.name`, { max: 214 }) });
  }
  // 契约的 item.anyOf：至少给出 repository 或 package 之一（否则这条目无从安装）
  if (!item.repository && !item.package) {
    throw new MarketError('bad-item', `${where} 既没有 repository 也没有 package（契约要求二者至少有一个）`);
  }
  if (raw.installSource !== undefined) {
    expectObj(raw.installSource, `${where}.installSource`);
    expectKeys(raw.installSource, ['kind', 'commit'], `${where}.installSource`);
    if (raw.installSource.kind !== 'github') throw new MarketError('bad-value', `${where}.installSource.kind 只支持 "github"`);
    const commit = expectStr(raw.installSource.commit, `${where}.installSource.commit`, { max: 40 });
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new MarketError('bad-value', `${where}.installSource.commit 必须是 40 位小写十六进制`);
    item.installSource = Object.freeze({ kind: 'github', commit });
  }
  if (raw.publisher !== undefined) {
    expectObj(raw.publisher, `${where}.publisher`);
    expectKeys(raw.publisher, ['name', 'url'], `${where}.publisher`);
    item.publisher = Object.freeze({
      name: expectStr(raw.publisher.name, `${where}.publisher.name`, { max: 120 }),
      url: raw.publisher.url === undefined ? undefined : assertAllowedUrl(raw.publisher.url, `${where}.publisher.url`, opts).href,
    });
  }
  if (raw.media !== undefined) {
    expectObj(raw.media, `${where}.media`);
    expectKeys(raw.media, ['icon'], `${where}.media`);
    expectObj(raw.media.icon, `${where}.media.icon`);
    expectKeys(raw.media.icon, ['url', 'alt'], `${where}.media.icon`);
    item.media = Object.freeze({
      icon: Object.freeze({
        url: assertAllowedUrl(raw.media.icon.url, `${where}.media.icon.url`, opts).href,
        alt: expectStr(raw.media.icon.alt, `${where}.media.icon.alt`, { max: 240, optional: true }),
      }),
    });
  }
  if (raw.capabilities !== undefined) {
    expectObj(raw.capabilities, `${where}.capabilities`);
    expectKeys(raw.capabilities, ['required', 'optional'], `${where}.capabilities`);
    const caps = {};
    for (const k of ['required', 'optional']) {
      if (raw.capabilities[k] === undefined) continue;
      const list = expectStrArray(raw.capabilities[k], `${where}.capabilities.${k}`, { max: 64 });
      for (const c of list) {
        if (!CAPABILITY_RE.test(c)) throw new MarketError('bad-value', `${where}.capabilities.${k} 里的「${c}」不是合法能力名（需要 a.b 形式）`);
      }
      caps[k] = Object.freeze(list.slice());
    }
    item.capabilities = Object.freeze(caps);
  }
  if (raw.compatibility !== undefined) {
    expectObj(raw.compatibility, `${where}.compatibility`);
    expectKeys(raw.compatibility, ['apiVersion', 'hosts'], `${where}.compatibility`);
    item.compatibility = Object.freeze({
      apiVersion: expectStr(raw.compatibility.apiVersion, `${where}.compatibility.apiVersion`, { max: 64, optional: true }),
      hosts: raw.compatibility.hosts === undefined ? undefined
        : Object.freeze(expectStrArray(raw.compatibility.hosts, `${where}.compatibility.hosts`, { max: 32 }).slice()),
    });
  }
  // item 级 xiaomo：非标准来源的安装信息入口（DSH 会拒收这个键，所以默认目录源不用它）
  item.xiaomo = raw.xiaomo === undefined ? null : parseExtensionEntry(raw.xiaomo, `${where}.xiaomo`, opts);
  return Object.freeze(item);
}

/** 解析并校验一页 provider page。 */
export function parsePage(json, opts = {}) {
  expectObj(json, '目录页');
  expectKeys(json, ['schemaVersion', 'generatedAt', 'revision', 'items', 'page'], '目录页');
  if (json.schemaVersion !== PAGE_SCHEMA_VERSION) {
    throw new MarketError('bad-version', `不支持的 schemaVersion「${json.schemaVersion}」（本实现只认 ${PAGE_SCHEMA_VERSION}）`);
  }
  if (!Array.isArray(json.items)) throw new MarketError('bad-type', 'items 应该是数组');
  if (json.items.length > MAX_PAGE_ITEMS) {
    throw new MarketError('too-many-items', `一页最多 ${MAX_PAGE_ITEMS} 条，收到 ${json.items.length} 条`);
  }
  expectObj(json.page, 'page');
  expectKeys(json.page, ['nextCursor', 'total'], 'page');
  const nextCursor = expectStr(json.page.nextCursor, 'page.nextCursor', { max: 2048, optional: true });
  const total = expectInt(json.page.total, 'page.total', { min: 0, optional: true });

  const items = json.items.map((raw, i) => parseItem(raw, i, opts));
  const seen = new Set();
  for (const it of items) {
    if (seen.has(it.id)) throw new MarketError('duplicate-id', `目录页里出现重复的 id「${it.id}」`);
    seen.add(it.id);
  }

  return Object.freeze({
    schemaVersion: PAGE_SCHEMA_VERSION,
    generatedAt: expectStr(json.generatedAt, 'generatedAt', { max: 64, optional: true }),
    revision: expectStr(json.revision, 'revision', { max: 160, optional: true }),
    items: Object.freeze(items),
    page: Object.freeze({ nextCursor, total }),
  });
}

// ─────────────────────────────────────────────────────────
// 旁挂扩展文档（小墨自己的格式）
//
// 它只回答一个问题：这个条目在小墨里**怎么装**。
// entry 允许写相对路径（相对本文档），于是同一份文档在生产 origin 与本机
// 127.0.0.1 下解析出各自可用的绝对地址 —— 目录源不用为每个环境各写一份。
// ─────────────────────────────────────────────────────────

const SHA256_RE = /^[0-9a-f]{64}$/;
const EXTENSION_KEYS = Object.freeze(['entry', 'sha256', 'kind', 'pluginId', 'minHost', 'bytes', 'notes']);

/** 解析单条扩展记录（item 级 xiaomo 与旁挂文档里的同名条目共用这一份校验）。 */
export function parseExtensionEntry(raw, where, opts = {}) {
  expectObj(raw, where);
  expectKeys(raw, EXTENSION_KEYS, where);

  const entry = expectStr(raw.entry, `${where}.entry`, { max: 2048 });
  const sha256 = expectStr(raw.sha256, `${where}.sha256`, { max: 64 });
  if (!SHA256_RE.test(sha256)) {
    throw new MarketError('bad-hash', `${where}.sha256 必须是 64 位小写十六进制（sha256），收到 ${JSON.stringify(sha256)}`);
  }
  const kind = expectStr(raw.kind, `${where}.kind`, { max: 24 });
  if (!PLUGIN_KINDS.includes(kind)) {
    throw new MarketError('bad-value', `${where}.kind「${kind}」不在小墨认识的种类里：${PLUGIN_KINDS.join(' / ')}`);
  }
  const bytes = expectInt(raw.bytes, `${where}.bytes`, { min: 1, max: MAX_PLUGIN_BYTES, optional: true });
  return Object.freeze({
    entry,
    sha256,
    kind,
    pluginId: expectStr(raw.pluginId, `${where}.pluginId`, { max: 160, optional: true }),
    minHost: expectStr(raw.minHost, `${where}.minHost`, { max: 32, optional: true }),
    bytes,
    notes: expectStr(raw.notes, `${where}.notes`, { max: 500, optional: true }),
    /** 来源标记：'item' 表示写在 provider page 的 item 上，'sidecar' 表示来自旁挂文档 */
    origin: opts.origin || 'sidecar',
  });
}

/** 解析旁挂扩展文档。 */
export function parseExtensions(json, opts = {}) {
  expectObj(json, '扩展文档');
  expectKeys(json, ['format', 'version', 'generatedAt', 'items'], '扩展文档');
  if (json.format !== EXTENSIONS_FORMAT) {
    throw new MarketError('bad-format', `不是小墨扩展文档（format 应为 "${EXTENSIONS_FORMAT}"）`);
  }
  if (json.version !== EXTENSIONS_VERSION) {
    throw new MarketError('bad-version', `不支持的扩展文档 version「${json.version}」（本实现只认 ${EXTENSIONS_VERSION}）`);
  }
  expectObj(json.items, '扩展文档 items');
  const items = {};
  for (const [id, raw] of Object.entries(json.items)) {
    items[id] = parseExtensionEntry(raw, `items["${id}"]`, { ...opts, origin: 'sidecar' });
  }
  return Object.freeze({
    format: EXTENSIONS_FORMAT,
    version: EXTENSIONS_VERSION,
    generatedAt: expectStr(json.generatedAt, 'generatedAt', { max: 64, optional: true }),
    items: Object.freeze(items),
  });
}

// ─────────────────────────────────────────────────────────
// 哈希
// ─────────────────────────────────────────────────────────

/** 十六进制 sha256。Node 24 与浏览器（含 http://127.0.0.1 这种安全上下文）都有 crypto.subtle。 */
export async function sha256Hex(buffer) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle || typeof subtle.digest !== 'function') {
    throw new MarketError('no-webcrypto', '当前环境没有 WebCrypto（crypto.subtle），无法校验哈希，因此拒绝安装');
  }
  const view = buffer instanceof ArrayBuffer
    ? buffer
    : (ArrayBuffer.isView(buffer) ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) : null);
  if (!view) throw new MarketError('bad-type', 'sha256Hex 需要一个 ArrayBuffer 或 TypedArray');
  const digest = await subtle.digest('SHA-256', view);
  let out = '';
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, '0');
  return out;
}

// ─────────────────────────────────────────────────────────
// 版本比较（只支持 x.y.z 与可选的 -pre / +build 尾巴）
// ─────────────────────────────────────────────────────────

export function compareVersions(a, b) {
  const norm = (v) => String(v == null ? '' : v).trim().replace(/^v/, '').split(/[-+]/)[0].split('.').map((x) => {
    const n = parseInt(x, 10);
    return Number.isFinite(n) ? n : 0;
  });
  const A = norm(a); const B = norm(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const d = (A[i] || 0) - (B[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// ─────────────────────────────────────────────────────────
// 宿主记录清理
//
// 内核没有「移除记录」的 API：host.uninstall() 只跑处置栈 + 摘贡献，记录会留在
// pending 里等着被再次 install（这对「停用/启用」是对的）。
// 但市场要的是「卸载后从清单与宿主里真的消失」，所以这里把记录从宿主的两个
// 公开容器里摘掉，并补一条 plugin:changed，否则清单服务不会知道要重算。
// ─────────────────────────────────────────────────────────

function forgetPlugin(host, id) {
  if (!host || !host.records || typeof host.records.get !== 'function') return false;
  const existed = host.records.has ? host.records.has(id) : !!host.records.get(id);
  if (!existed) return false;
  try { host.uninstall(id); } catch { /* 已经没装过：继续把记录摘干净 */ }
  if (typeof host.records.delete === 'function') host.records.delete(id);
  if (Array.isArray(host.order)) {
    const i = host.order.indexOf(id);
    if (i >= 0) host.order.splice(i, 1);
  }
  bus.emit('plugin:changed', { id, action: 'uninstall', phase: 'pending', offBy: 'item' });
  return true;
}

// ─────────────────────────────────────────────────────────
// 本地状态（来源列表 + 已装记录）
// ─────────────────────────────────────────────────────────

function defaultStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

function readState(storage) {
  if (!storage || typeof storage.getItem !== 'function') return null;
  try {
    const v = JSON.parse(storage.getItem(MARKET_KEY) || 'null');
    return isObj(v) ? v : null;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────
// 目录客户端
// ─────────────────────────────────────────────────────────

export class MarketClient {
  /**
   * @param {object} [opts]
   * @param {object} [opts.app]     宿主 App（install/uninstall 需要它的 host）
   * @param {object} [opts.storage] Storage 替身；显式传 null = 只在内存里活（测试用）
   * @param {Function} [opts.fetch] fetch 替身
   * @param {Function} [opts.now]   时间源替身
   */
  constructor(opts = {}) {
    this.app = opts.app || null;
    this.storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    this.fetchImpl = opts.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    this.now = opts.now || (() => Date.now());
    this.allowLoopback = opts.allowLoopback !== false;
    this._subs = [];
    this._state = readState(this.storage) || {};
    this._sources = Array.isArray(this._state.sources) ? this._state.sources.filter(isObj).map(normalizeSourceRecord) : [];
    this._installed = isObj(this._state.installed) ? { ...this._state.installed } : {};
    /** 目录缓存：只活在内存里，刷新就重拉（缓存策略属于界面，不属于内核） */
    this._catalogs = new Map();
    this.seeded = this._state.seeded === true;
  }

  // ── 订阅 ────────────────────────────────────────────────
  onChange(fn) {
    if (typeof fn !== 'function') throw new TypeError('[market] onChange 需要一个函数');
    this._subs.push(fn);
    return () => { const i = this._subs.indexOf(fn); if (i >= 0) this._subs.splice(i, 1); };
  }

  _emit() {
    const snap = this.snapshot();
    for (const fn of this._subs.slice()) {
      try { fn(snap); } catch (e) { console.error('[market] 订阅回调异常', e); }
    }
    return snap;
  }

  /** 冻结的只读视图：界面只读它，不读内部结构 */
  snapshot() {
    return Object.freeze({
      sources: Object.freeze(this._sources.map((s) => Object.freeze({ ...s }))),
      installed: Object.freeze(Object.values(this._installed).map((r) => Object.freeze({ ...r }))),
    });
  }

  // ── 持久化 ──────────────────────────────────────────────
  _save() {
    const s = this.storage;
    this._state = { v: 1, seeded: this.seeded, sources: this._sources, installed: this._installed };
    if (!s || typeof s.setItem !== 'function') return;   // 无存储（Node / 无痕）：状态只活在内存里
    try { s.setItem(MARKET_KEY, JSON.stringify(this._state)); } catch { /* 配额满：功能照常，只是留不到下次 */ }
  }

  // ── 来源 ────────────────────────────────────────────────
  listSources() { return this._sources.map((s) => ({ ...s })); }

  getSource(id) { return this._sources.find((s) => s.id === id) || null; }

  /**
   * 登记一个来源。必须先真的把 manifest 拉回来并校验通过 ——
   * 「添加来源」这一步就是契约里用户明确表态的地方，不能先存一个未知 URL 再说。
   */
  async addSource(manifestUrl, { signal, bundled = false } = {}) {
    const url = assertAllowedUrl(manifestUrl, '来源 manifest 地址', { allowQuery: true, allowLoopback: this.allowLoopback });
    const json = await this._fetchJson(url.href, { signal, where: '来源 manifest' });
    const source = parseSource(json, { allowLoopback: this.allowLoopback });
    if (this.getSource(url.href)) {
      throw new MarketError('duplicate-source', `这个来源已经登记过了：${source.name}`);
    }
    const rec = normalizeSourceRecord({
      id: url.href,
      url: url.href,
      providerId: source.providerId,
      name: source.name,
      endpoint: source.transport.endpoint,
      extensionsUrl: source.extensionsUrl,
      dev: source.dev,
      bundled: !!bundled,
      addedAt: new Date(this.now()).toISOString(),
    });
    this._sources.push(rec);
    this._save();
    this._emit();
    return { ...rec };
  }

  /**
   * 移除来源。已经装上的插件**不会被自动卸掉** —— 移除来源是「不再浏览它」，
   * 不是「卸掉从它装的东西」；后者是用户对已装插件的独立决定，界面会明确写出来。
   */
  removeSource(id) {
    const i = this._sources.findIndex((s) => s.id === id);
    if (i < 0) return false;
    this._sources.splice(i, 1);
    this._catalogs.delete(id);
    this._save();
    this._emit();
    return true;
  }

  /** 首次运行时登记内置目录源。只登记（不联网）：契约禁止启动时阻塞式 fetch。 */
  seedDefaultSource(manifestUrl) {
    if (this.seeded || !manifestUrl) return null;
    const url = String(manifestUrl);
    this.seeded = true;
    if (!this.getSource(url)) {
      this._sources.push(normalizeSourceRecord({
        id: url, url, name: '小墨实验室 · 内置社区目录', providerId: 'lab.xiaomo.community-catalog',
        endpoint: '', extensionsUrl: '', dev: false, bundled: true, addedAt: new Date(this.now()).toISOString(),
      }));
    }
    this._save();
    this._emit();
    return this.getSource(url);
  }

  // ── 目录 ────────────────────────────────────────────────
  /**
   * 拉一份目录并合并安装信息。
   * 静态托管没有服务端筛选，所以**全量返回 + 本地筛选**（契约明确允许标准来源
   * 只提供有界本地索引；manifest 的 query.supported 如实声明为 []）。
   */
  async fetchCatalog(sourceRef, { signal } = {}) {
    let rec = typeof sourceRef === 'string' ? this.getSource(sourceRef) : sourceRef;
    if (!rec) throw new MarketError('no-source', '没有这个来源');
    rec = await this._hydrate(rec, { signal });

    const json = await this._fetchJson(rec.endpoint, { signal, where: `目录（${rec.name}）` });
    const page = parsePage(json, { allowLoopback: this.allowLoopback });

    // 旁挂扩展文档：拉不到不算错（第三方 DSH 来源本来就没有它），
    // 但错误要如实带出去，界面上显示「该来源没有提供小墨安装信息」而不是假装能装。
    let sidecar = { found: false, url: rec.extensionsUrl || extensionsUrlFor(new URL(rec.endpoint)), error: null, items: {} };
    try {
      const raw = await this._fetchJson(sidecar.url, { signal, where: '扩展文档', optional: true });
      if (raw !== null) {
        const ext = parseExtensions(raw, { allowLoopback: this.allowLoopback });
        sidecar = { found: true, url: sidecar.url, error: null, items: ext.items, doc: ext };
      }
    } catch (e) {
      sidecar.error = e && e.message ? e.message : String(e);
    }

    const items = page.items.map((it) => {
      const entry = resolveEntry(it, sidecar, rec, this.allowLoopback, isPackagedSource(rec));
      // thirdParty：不是内置目录就意味着「这份代码没经过本仓库 PR 审核」。
      // 界面上要如实打出「第三方代码」徽标 —— 信任模型对齐 DSH（精选来源 + 显式警告），
      // 而不是假装校验过了哈希就等于安全。
      return Object.freeze({
        ...it,
        sourceId: rec.id,
        sourceName: rec.name,
        sourceUrl: rec.url,
        thirdParty: !rec.bundled,
        devSource: !!rec.dev,
        entry,
      });
    });
    const catalog = Object.freeze({
      source: { ...rec },
      items: Object.freeze(items),
      total: page.page.total === undefined ? items.length : page.page.total,
      extensions: { found: sidecar.found, url: sidecar.url, error: sidecar.error },
      fetchedAt: new Date(this.now()).toISOString(),
    });
    this._catalogs.set(rec.id, catalog);
    this._emit();
    return catalog;
  }

  /** 内存里的目录缓存（界面重开抽屉时先用它，按需刷新） */
  cachedCatalog(sourceId) { return this._catalogs.get(sourceId) || null; }

  /**
   * 把只有 URL 的来源记录补全（拉一次 manifest 填上 endpoint / 旁挂文档地址）。
   * 为什么需要它：内置来源是 seedDefaultSource 登记的，那里**不联网**
   * （契约禁止启动时阻塞式 fetch）。于是「已登记但还没解析」是个正常状态，
   * 第一次真正去拉目录时才把 manifest 取回来并落盘。
   */
  async _hydrate(rec, { signal } = {}) {
    if (rec.endpoint) return rec;
    const json = await this._fetchJson(rec.url, { signal, where: `来源 manifest（${rec.name}）` });
    const src = parseSource(json, { allowLoopback: this.allowLoopback, allowPackaged: isPackagedSource(rec) });
    const patched = normalizeSourceRecord({
      ...rec,
      providerId: src.providerId,
      endpoint: src.transport.endpoint,
      extensionsUrl: src.extensionsUrl,
      dev: src.dev,
    });
    const i = this._sources.findIndex((s) => s.id === rec.id);
    if (i >= 0) this._sources[i] = patched;
    this._save();
    this._emit();
    return patched;
  }

  // ── 安装 ────────────────────────────────────────────────
  /**
   * 安装前预览：把代码拉下来、算哈希、如实报告，但**不缓存字节**。
   * 真正安装时会重新拉一次并重新校验 —— 预览与安装之间文件可能被换掉，
   * 拿预览时的那份去装就等于把校验变成了装饰（TOCTOU）。
   */
  async installCheck(deal, { signal } = {}) {
    const x = deal && deal.entry;
    if (!x) throw new MarketError('not-installable', '该条目没有提供小墨安装信息（来源未提供旁挂扩展文档）');
    if (x.issue) throw new MarketError('not-installable', x.issue);
    const buf = await this._fetchBytes(x.href, { signal, where: `插件代码（${deal.displayName || deal.id}）` });
    const actual = await sha256Hex(buf);
    const hashOk = actual === x.sha256;
    return Object.freeze({
      itemId: deal.id,
      name: deal.displayName || deal.id,
      version: deal.latestVersion || '',
      publisher: deal.publisher ? deal.publisher.name : '',
      summary: deal.summary || '',
      sourceName: deal.sourceName || '',
      sourceUrl: deal.sourceUrl || '',
      thirdParty: !!deal.thirdParty,
      entryUrl: x.href,
      bytes: buf.byteLength,
      declaredBytes: x.bytes,
      declaredSha: x.sha256,
      actualSha: actual,
      hashOk,
      dev: !!x.dev,
      kind: x.kind,
      pluginId: x.pluginId || '',
      minHost: x.minHost || '',
      notes: x.notes || '',
      alreadyInstalled: this.getInstalled(x.pluginId) || null,
    });
  }

  /**
   * 安装 / 更新：拉单文件 ESM → 校验 sha256 → Blob + objectURL → 动态 import → define + install。
   * 任何一步不过都抛 MarketError，且不留下半个插件。
   */
  async install(deal, { signal, expectedSha = null } = {}) {
    const x = deal && deal.entry;
    if (!x) throw new MarketError('not-installable', '该条目没有提供小墨安装信息（来源未提供旁挂扩展文档）');
    if (x.issue) throw new MarketError('not-installable', x.issue);

    const host = this._host();
    if (!host) throw new MarketError('no-host', '宿主还没起来，装不了插件');

    const buf = await this._fetchBytes(x.href, { signal, where: `插件代码（${deal.displayName || deal.id}）` });
    const actual = await sha256Hex(buf);
    const want = expectedSha || x.sha256;
    if (actual !== want) {
      throw new MarketError('hash-mismatch',
        `哈希不符，已拒绝安装：目录声明 ${short(want)}，这次拉到的实际是 ${short(actual)}。`
        + '文件在发布之后被改动过，或本地有缓存/代理改写了内容。');
    }
    if (typeof x.bytes === 'number' && x.bytes !== buf.byteLength) {
      // bytes 只是辅助信息，不一致不该拦住安装，但要留下痕迹
      console.warn(`[market] ${deal.id} 声明字节数 ${x.bytes}，实际 ${buf.byteLength}`);
    }

    const plugin = await importPluginBytes(buf);
    if (x.pluginId && plugin.id !== x.pluginId) {
      throw new MarketError('id-mismatch',
        `插件自报 id「${plugin.id}」与目录声明的「${x.pluginId}」不一致，拒绝安装（防止同一目录条目被换成别的插件）`);
    }

    // 更新或重装：旧记录必须先彻底消失，否则 host.define() 会把新代码丢掉（同名 id 重复声明只警告不覆盖）
    forgetPlugin(host, plugin.id);
    host.define(plugin);
    const ok = host.install(plugin.id);
    if (!ok) {
      const rec = host.get ? host.get(plugin.id) : null;
      const why = (rec && rec.error) || '未说明的错误';
      forgetPlugin(host, plugin.id);        // 半装的东西清干净，别让它以 failed 的形态留在清单里
      throw new MarketError('setup-failed', `插件装载失败：${why}`);
    }

    const version = deal.latestVersion || plugin.version || '1.0.0';
    this._installed[plugin.id] = {
      id: plugin.id,
      itemId: deal.id,
      name: plugin.name || deal.displayName || plugin.id,
      version,
      hash: actual,
      kind: plugin.kind || x.kind || 'misc',
      entry: x.href,
      sourceId: deal.sourceId || '',
      sourceName: deal.sourceName || '',
      sourceUrl: deal.sourceUrl || '',
      installedAt: new Date(this.now()).toISOString(),
    };
    this._save();
    this._emit();
    return { ok: true, id: plugin.id, version, hash: actual };
  }

  /**
   * 卸载：拆贡献 + 摘记录 + 清本地记录，三件事都要真发生。
   * 不承诺「把代码从内存里清掉」—— ESM 没有卸载 API，详见 importPluginBytes 的说明。
   */
  uninstall(id) {
    const rec = this._installed[id];
    if (!rec) return false;
    const host = this._host();
    if (host) forgetPlugin(host, id);
    delete this._installed[id];
    this._save();
    this._emit();
    return true;
  }

  getInstalled(id) { return this._installed[id] ? { ...this._installed[id] } : null; }

  installedList() { return Object.values(this._installed).map((r) => ({ ...r })); }

  /** 已装插件的目录条目（用来判断更新；目录没拉过就返回空） */
  findDeal(itemId, sourceId = null) {
    for (const [sid, cat] of this._catalogs) {
      if (sourceId && sid !== sourceId) continue;
      const hit = cat.items.find((it) => it.id === itemId);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * 更新检测：只有「拉过目录」才谈得上检测。
   * 判据两条：目录里的 latestVersion 比已装版本新，或目录声明的哈希与已装哈希不同
   * （同版本换实现也要提示，否则用户永远卡在旧代码上）。
   */
  async checkUpdates(sourceRef, { signal } = {}) {
    const cat = await this.fetchCatalog(sourceRef, { signal });
    const out = [];
    for (const rec of Object.values(this._installed)) {
      if (rec.sourceId && rec.sourceId !== cat.source.id) continue;
      const deal = cat.items.find((it) => it.id === rec.itemId || (it.entry && it.entry.pluginId === rec.id));
      if (!deal || !deal.entry) continue;
      const newer = deal.latestVersion ? compareVersions(deal.latestVersion, rec.version) > 0 : false;
      const changed = deal.entry.sha256 && deal.entry.sha256 !== rec.hash;
      if (!newer && !changed) continue;
      out.push({
        id: rec.id, itemId: deal.id, from: rec.version, to: deal.latestVersion || rec.version,
        reason: newer ? 'version' : 'hash', item: deal,
      });
    }
    return out;
  }

  // ── 网络 ────────────────────────────────────────────────
  _host() {
    const app = this.app;
    return app && app.host ? app.host : null;
  }

  async _fetchRaw(url, { signal, where, optional = false } = {}) {
    const f = this.fetchImpl;
    if (typeof f !== 'function') throw new MarketError('no-fetch', '当前环境没有 fetch，无法访问目录');
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, FETCH_TIMEOUT_MS);
    const onAbort = () => ctl.abort();
    if (signal) {
      if (signal.aborted) ctl.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      let res;
      try {
        // credentials:'omit' —— 契约要求不携带任何 ambient cookie / authorization
        res = await f(url, {
          signal: ctl.signal,
          credentials: 'omit',
          redirect: 'follow',
          referrerPolicy: 'no-referrer',
          headers: { accept: 'application/json, text/plain, */*' },
        });
      } catch (e) {
        if (optional) return null;
        // 自己超时和别人拒收要分开说：一律说成 CORS 会把用户带偏。
        if (timedOut) {
          throw new MarketError('timeout', `${where}拉取超时：${Math.round(FETCH_TIMEOUT_MS / 1000)} 秒内没有响应`);
        }
        // fetch 把「跨站被拒（CORS）」和「网络不通」压成同一种 TypeError，
        // 分不出来就得如实说明两种可能 —— 静默成空目录是最坏的选项：
        // 用户会以为来源里没有插件，而其实是浏览器根本没让读。
        // （实测：jsdelivr/unpkg 带 Access-Control-Allow-Origin: *，可直取；
        //   GitHub Releases 与 codeload 不支持 CORS，不能用来做浏览器直连分发。）
        const msg = e && e.message ? e.message : String(e);
        throw new MarketError('cors-or-network',
          `${where}拉取失败：可能是这个来源不允许跨站读取（CORS），也可能是网络不通。（${msg}）`);
      }
      if (!res.ok) {
        if (optional && (res.status === 404 || res.status === 403)) return null;   // 没有旁挂文档是常态
        throw new MarketError(`http-${res.status}`, `${where}返回 HTTP ${res.status}`);
      }
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_JSON_BYTES && where !== '插件代码') {
        throw new MarketError('too-large', `${where}超过上限（${buf.byteLength} > ${MAX_JSON_BYTES} 字节）`);
      }
      return buf;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  async _fetchJson(url, { signal, where = 'JSON', optional = false } = {}) {
    const buf = await this._fetchRaw(url, { signal, where, optional });
    if (buf === null) return null;
    let text;
    try { text = new TextDecoder('utf-8', { fatal: false }).decode(buf); }
    catch (e) { throw new MarketError('bad-encoding', `${where}不是有效的 UTF-8：${e.message}`); }
    try { return JSON.parse(text); }
    catch (e) { throw new MarketError('bad-json', `${where}不是合法 JSON：${e.message}`); }
  }

  async _fetchBytes(url, { signal, where } = {}) {
    const buf = await this._fetchRaw(url, { signal, where });
    if (buf.byteLength > MAX_PLUGIN_BYTES) {
      throw new MarketError('too-large', `${where}超过单文件上限（${buf.byteLength} > ${MAX_PLUGIN_BYTES} 字节）`);
    }
    return buf;
  }
}

// ─────────────────────────────────────────────────────────
// 内部小工具
// ─────────────────────────────────────────────────────────

const short = (h) => (typeof h === 'string' ? h.slice(0, 8) + '…' : String(h));

function normalizeSourceRecord(s) {
  return {
    id: String(s.id || s.url || ''),
    url: String(s.url || s.id || ''),
    name: String(s.name || s.url || '未命名来源'),
    providerId: String(s.providerId || ''),
    endpoint: String(s.endpoint || ''),
    extensionsUrl: String(s.extensionsUrl || ''),
    dev: !!s.dev,
    bundled: !!s.bundled,
    addedAt: s.addedAt || null,
  };
}

/**
 * 把「目录条目 + 旁挂文档」合成一个安装入口。
 * item 级 xiaomo 优先于旁挂文档（它离条目更近，且是显式写在这一条上的）。
 * 解析不出可用入口时**不抛错**：目录主体仍然可以浏览，只是这条装不了，
 * 原因写进 entry.issue 由界面如实显示。
 */
function resolveEntry(item, sidecar, source, allowLoopback, allowPackaged = false) {
  const rawEntry = item.xiaomo || (sidecar.items ? sidecar.items[item.id] : null) || null;
  if (!rawEntry) {
    return Object.freeze({
      available: false,
      issue: source.bundled && sidecar.error
        ? `本来源没有提供小墨安装信息（${sidecar.error}）`
        : '本来源没有提供小墨安装信息（缺少旁挂扩展文档）',
    });
  }
  let resolved;
  try {
    const abs = new URL(rawEntry.entry, sidecar.url || source.endpoint).href;
    const ok = assertAllowedUrl(abs, '插件入口', { allowQuery: true, allowLoopback, allowPackaged });
    resolved = ok;
  } catch (e) {
    return Object.freeze({ available: false, issue: `插件入口不可用：${e.message}` });
  }
  if (rawEntry.minHost && compareVersions(HOST_VERSION, rawEntry.minHost) < 0) {
    return Object.freeze({
      available: false,
      sha256: rawEntry.sha256, kind: rawEntry.kind, pluginId: rawEntry.pluginId, minHost: rawEntry.minHost,
      issue: `需要宿主 ≥ ${rawEntry.minHost}，当前是 ${HOST_VERSION}`,
    });
  }
  return Object.freeze({
    available: true,
    issue: null,
    href: resolved.href,
    dev: resolved.dev,
    sha256: rawEntry.sha256,
    kind: rawEntry.kind,
    pluginId: rawEntry.pluginId || '',
    minHost: rawEntry.minHost || '',
    bytes: rawEntry.bytes,
    notes: rawEntry.notes || '',
    from: rawEntry.origin || 'sidecar',
  });
}

/**
 * Blob URL + 动态 import()。
 *
 * 为什么非得绕 blob 这一圈（两条都是实测出来的正当理由）：
 *   ① blob URL 里**无法解析相对 import** —— 于是「社区插件必须单文件零依赖，
 *      只能通过 setup(ctx) 拿宿主能力」不是纪律要求，而是技术的硬边界；
 *   ② `import(blobUrl)` **绕过了 module script 的 MIME 校验** —— 很多静态托管
 *      （实测：raw.githubusercontent.com 对 .js 常回 text/plain）会把模块当纯文本发，
 *      直接从 URL import 会被浏览器以 MIME 不符拒掉，走 blob 则不受影响。
 *
 * 代价（必须诚实）：ESM 没有模块卸载 API。所以「卸载」能做的只有三件事 ——
 * 宿主把贡献与插槽拆干净（内核处置栈负责）、revokeObjectURL、从市场记录里删掉，
 * 下次启动不再装。模块字节仍留在内存里，只是不再被引用。界面文案不许承诺「彻底清除」。
 *
 * 导入后立刻 revokeObjectURL：模块已经求值完，留着只是泄漏。
 */
async function importPluginBytes(buf) {
  if (typeof Blob !== 'function' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new MarketError('no-blob', '当前环境不支持 Blob URL，无法装载第三方插件');
  }
  const url = URL.createObjectURL(new Blob([buf], { type: 'text/javascript' }));
  try {
    let mod;
    try {
      mod = await import(/* 动态：blob URL 由运行时给出，打包器不必处理 */ url);
    } catch (e) {
      throw new MarketError('import-failed', `插件代码无法执行：${e && e.message ? e.message : e}`);
    }
    const plugin = mod && (mod.default || mod.plugin);
    if (!isObj(plugin) || typeof plugin.id !== 'string' || !plugin.id) {
      throw new MarketError('bad-plugin', '插件模块没有导出合法的插件对象（需要 default 导出且带非空 id）');
    }
    if (plugin.setup !== undefined && typeof plugin.setup !== 'function') {
      throw new MarketError('bad-plugin', '插件的 setup 不是函数');
    }
    return plugin;
  } finally {
    try { URL.revokeObjectURL(url); } catch { /* 已经被回收 */ }
  }
}

/**
 * 本项目的规范目录源地址（远端 Pages 上的那一份）。
 *
 * 为什么要由一个常量持有：**目录源不能自举** —— 应用必须先知道「自己的规范 origin 在哪」，
 * 才谈得上去读那份 manifest。`file://` 这类页面 origin 根本不是可用的来源地址，所以必须回退到这里。
 * `app://`（桌面版）不在这里：从 2.0 起它改走包内的离线 manifest（见下文的 ③ 与 LOCAL_MANIFEST_PATH）
 * —— 桌面版要能在**完全没有网络**的环境里工作，而远端 Pages 在那时必然拉不到。
 * 这个地址与 market/catalog-source.json 里声明的站点是同一个（GitHub Pages）。
 */
export const PRODUCTION_MANIFEST_URL = 'https://yumoii789.github.io/xiaomo-lab/market/catalog-source.json';

/** 随包发布的离线目录 manifest（相对包根）。桌面版 `app://` 下的默认来源就是它。 */
export const LOCAL_MANIFEST_PATH = 'market/catalog-source.local.json';

/**
 * 默认目录源：按页面 origin 分四种情况。
 *
 *   ① 回环 http（本机开发）→ 开发 manifest（market/_dev-fixtures/…）
 *      理由：本机把 github.io 解析到了 127.0.0.1（见 plans/02-发布与环境.md），生产 manifest
 *      的 endpoint 指向 Pages，本地跑不通；开发 manifest 只有 endpoint 的 origin 不同，
 *      指向的目录页是同一份文件。
 *   ② https:（Pages 与任何自建站点）→ 同源 market/catalog-source.json
 *      理由：同源最可靠，而且压根不需要 CORS。
 *   ③ `app:`（桌面版：`app://xiaomo-lab/index.html`）→ **打包内的离线 manifest**
 *      （market/catalog-source.local.json，它的 endpoint 指向包内的 market/v1/plugins）。
 *      理由：桌面版必须能在**完全没有网络**的环境里把市场用起来（用户的硬要求），
 *      而远端 Pages 在没有网的时候必然拉不到。包内这份目录与 Pages 上是同一份内容，
 *      变的只是 endpoint 的地址。想要实时目录的用户可以在「来源」页手动登记
 *      Pages 上那份 manifest —— 它是 HTTPS，走的还是同一条校验。
 *   ④ 其它一切（`file:` / 非回环 http / 未知协议）→ 生产 HTTPS manifest
 *      理由：http(s) 之外的协议一律进不了 assertAllowedUrl（`app:` 已单列一支，见上 ——
 *      它由宿主自己从磁盘供给、不走网络），**本方案不为此放宽校验**（「只收 HTTPS + 回环开发例外」
 *      是它的立身之本），所以只能回退到远端。未知协议也走这一支：宁可回到一个确定可用的远端来源，
 *      也不给调用方一个必然被拒的地址。
 *
 * 不变量：**任何输入下返回的都是 assertAllowedUrl 能通过的地址**。null / 畸形 href 同样回退到远端，
 * 而不是返回 null —— 让调用方拿到一个可用的默认来源，比让它自己处理 null 更不容易出错；
 * 真要去掉默认来源是用户的显式动作（「来源」页里移除）。
 */
export function defaultManifestUrl(loc = (typeof location !== 'undefined' ? location : null)) {
  try {
    const href = loc && loc.href ? String(loc.href) : '';
    const u = href ? new URL(href) : null;
    if (u) {
      if (u.protocol === 'app:') {
        return new URL(LOCAL_MANIFEST_PATH, u.href).href;
      }
      if (u.protocol === 'http:' && isLoopbackHost(u.hostname)) {
        return new URL('market/_dev-fixtures/dev/catalog-source.local.json', u.href).href;
      }
      if (u.protocol === 'https:') {
        return new URL('market/catalog-source.json', u.href).href;
      }
    }
  } catch { /* 畸形 href：落到下面的远端回退，不抛也不返回 null */ }
  return PRODUCTION_MANIFEST_URL;
}

export default MarketClient;
