#!/usr/bin/env node
/**
 * sync-diary.mjs — SwashbucklerDiary 备份 → 静态站日记数据生成器
 *
 * 契约：F:\AI\Workspace\dsh\diary-contract.md（schema=1 / 加密见「三」「三·补」）
 *
 * 零运行时依赖：zip 用 node:zlib 自解析，SQLite 用 node:sqlite（Node ≥ 22.5）。
 * 不需要 unzip / 7z / sqlite3 等系统命令，Windows 本机与 ubuntu-latest 行为一致。
 *
 * 用法：
 *   node tools/sync-diary.mjs                      # 本机模式，自动扫坚果云目录取最新 zip
 *   node tools/sync-diary.mjs --local --dir D:\path
 *   node tools/sync-diary.mjs --zip  xxx.zip
 *   node tools/sync-diary.mjs --webdav             # 从坚果云 WebDAV 取最新 zip
 *   node tools/sync-diary.mjs --webdav --list      # 只列目录（排查用）
 *   node tools/sync-diary.mjs --dry-run --verbose
 *
 * 模式：
 *   设置 DIARY_PASSWORD（或 tools/config.json 的 password）→ 密码模式：
 *     只输出 diary/data/diaries.enc.json，diaries.json 会被删除；
 *     媒体输出 diary/media/<basename>.enc（iv12 || AES-256-GCM 密文+tag）。
 *   未设置 → 明文模式：diary/data/diaries.json + diary/media/<basename>。
 */

import { createDecipheriv, createCipheriv, createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = __dirname;
const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..');

const SCHEMA = 1;
const KDF_ITERATIONS = 200000; // 契约固定：PBKDF2-SHA256 200000 轮
const GCM_IV_BYTES = 12; // 契约固定：12B iv
const GCM_TAG_BYTES = 16;

const BACKUP_NAME_RE = /^SwashbucklerDiaryBackup_(\d{14})_v([0-9][0-9A-Za-z.\-]*?)\.zip$/i;
const MEDIA_URI_RE = /appdata:\/\/\/[^\s)"'<>\\]+|appdata\/[^\s)"'<>\\]+/g;

// ─────────────────────────── 小工具 ───────────────────────────

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);
let VERBOSE = false;
const vlog = (...a) => { if (VERBOSE) console.log('[debug]', ...a); };

function fail(msg, hint) {
  const e = new Error(msg);
  e.hint = hint;
  throw e;
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ────────────────────── 纯 node:zlib 的 ZIP 读取 ──────────────────────

class ZipArchive {
  constructor(buf) {
    this.buf = buf;
    this.entries = this.#readCentralDirectory();
  }

  #readCentralDirectory() {
    const buf = this.buf;
    const EOCD_SIG = 0x06054b50;
    const Z64_LOC_SIG = 0x07064b50;
    let eocd = -1;
    const from = Math.max(0, buf.length - (0xffff + 22 + 64));
    for (let i = buf.length - 22; i >= from; i--) {
      if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) fail('不是有效的 zip：找不到 EOCD 记录', '确认下载的是完整的 SwashbucklerDiaryBackup_*.zip，不是 HTML 登录页');

    let count = buf.readUInt16LE(eocd + 10);
    let cdSize = buf.readUInt32LE(eocd + 12);
    let cdOffset = buf.readUInt32LE(eocd + 16);

    // zip64：目录超过 4GB / 6.5 万条目时（本项目基本不会遇到，做兜底）
    if (cdOffset === 0xffffffff || count === 0xffff || cdSize === 0xffffffff) {
      const loc = eocd - 20;
      if (loc < 0 || buf.readUInt32LE(loc) !== Z64_LOC_SIG) fail('zip64 结构损坏：找不到 zip64 EOCD locator');
      const z64 = Number(buf.readBigUInt64LE(loc + 8));
      count = Number(buf.readBigUInt64LE(z64 + 32));
      cdSize = Number(buf.readBigUInt64LE(z64 + 40));
      cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
    }

    const entries = [];
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) fail('zip 中央目录损坏（条目头签名不匹配）');
      const flags = buf.readUInt16LE(p + 8);
      const method = buf.readUInt16LE(p + 10);
      const crc = buf.readUInt32LE(p + 16);
      let csize = buf.readUInt32LE(p + 20);
      let usize = buf.readUInt32LE(p + 24);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      let localOffset = buf.readUInt32LE(p + 42);
      const rawName = buf.subarray(p + 46, p + 46 + nameLen);
      const name = (flags & 0x800 ? rawName.toString('utf8') : rawName.toString('utf8'));

      // zip64 扩展字段（0x0001）
      let ep = p + 46 + nameLen;
      const epEnd = ep + extraLen;
      while (ep + 4 <= epEnd) {
        const id = buf.readUInt16LE(ep);
        const sz = buf.readUInt16LE(ep + 2);
        if (id === 0x0001) {
          let q = ep + 4;
          if (usize === 0xffffffff && q + 8 <= epEnd) { usize = Number(buf.readBigUInt64LE(q)); q += 8; }
          if (csize === 0xffffffff && q + 8 <= epEnd) { csize = Number(buf.readBigUInt64LE(q)); q += 8; }
          if (localOffset === 0xffffffff && q + 8 <= epEnd) { localOffset = Number(buf.readBigUInt64LE(q)); q += 8; }
        }
        ep += 4 + sz;
      }

      if (!name.endsWith('/')) entries.push({ name, method, crc, csize, usize, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  /** 解出一个条目为 Buffer（带 CRC 校验） */
  read(name) {
    const e = this.entries.find((x) => x.name === name);
    if (!e) return null;
    return this.readEntry(e);
  }

  readEntry(e) {
    const buf = this.buf;
    const p = e.localOffset;
    if (buf.readUInt32LE(p) !== 0x04034b50) fail(`zip 局部头损坏：${e.name}`);
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const start = p + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + e.csize);

    let out;
    if (e.method === 0) out = Buffer.from(raw);
    else if (e.method === 8) out = zlib.inflateRawSync(raw);
    else fail(`不支持的 zip 压缩方式 ${e.method}（条目 ${e.name}）`, '换一台机器重新打包，或改用 store/deflate');

    if (out.length !== e.usize) fail(`zip 条目大小不符：${e.name}（得到 ${out.length}，应为 ${e.usize}）`);
    if (crc32(out) !== e.crc >>> 0) fail(`zip 条目 CRC 校验失败：${e.name}`);
    return out;
  }

  find(pred) {
    return this.entries.find(pred) ?? null;
  }

  readMatched(pred) {
    const e = this.find(pred);
    return e ? this.readEntry(e) : null;
  }
}

// ────────────────────── 时间与文本处理 ──────────────────────

/** '2026-09-05 19:27:45.169' → '2026-09-05 19:27:45'（契约：保持 YYYY-MM-DD HH:mm:ss） */
function normalizeDbTime(v) {
  if (v == null) return '';
  const s = String(v).trim();
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(s);
  return m ? `${m[1]} ${m[2]}` : s;
}

/** version.json 的 DateTime → 'YYYY-MM-DDTHH:mm:ss+08:00'（不经过本机时区，CI 在 UTC 也稳定） */
function normalizeIsoTime(v) {
  if (v == null) return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.exec(String(v).trim());
  if (!m) return null;
  return `${m[1]}T${m[2]}${m[3] === 'Z' ? '+00:00' : (m[3] ?? '+08:00')}`;
}

/** '20261030202537' → '2026-10-30T20:25:37+08:00' */
function isoFromStamp(stamp) {
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T` +
    `${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}+08:00`;
}

/** 去 markdown 标记，得到纯文本（保留换行） */
function toPlainText(md) {
  if (!md) return '';
  let s = String(md).replace(/\r\n?/g, '\n');
  s = s.replace(/```[\s\S]*?(?:```|$)/g, ' ');
  s = s.replace(/~~~[\s\S]*?(?:~~~|$)/g, ' ');
  s = s.replace(/`([^`]*)`/g, '$1');
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, '');
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  s = s.replace(/^\s{0,3}>\s?/gm, '');
  s = s.replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '');
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, '');
  s = s.replace(/(\*\*|__|~~|\*|_)/g, '');
  s = s.replace(/^\s*\|/gm, '').replace(/\|\s*$/gm, '').replace(/\|/g, ' ');
  return s;
}

/** 契约规则 5：中文按字符、英文按词 */
function countWords(plain) {
  if (!plain) return 0;
  const cjk = plain.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g);
  const latin = plain.match(/[A-Za-z0-9][A-Za-z0-9'’\-]*/g);
  return (cjk ? cjk.length : 0) + (latin ? latin.length : 0);
}

function firstLineTitle(plain) {
  for (const line of plain.split('\n')) {
    const t = line.trim();
    if (t) return t.slice(0, 40); // 契约规则 4：截断 40 字符
  }
  return '';
}

function makeExcerpt(plain) {
  return plain.replace(/\s+/g, ' ').trim().slice(0, 120); // 契约：纯文本前 120 字
}

/** 规范化资源 uri：appdata:///Image/x.jpg → appdata/Image/x.jpg */
function normalizeMediaUri(raw) {
  const uri = raw.replace(/^appdata:\/\/\//, 'appdata/');
  return uri.replace(/[.,;:]+$/, '');
}
const mediaBasename = (uri) => uri.slice(uri.lastIndexOf('/') + 1);

/** 从正文里抽 appdata 引用（保序去重） */
function extractMediaUris(markdown) {
  const out = [];
  const seen = new Set();
  for (const m of String(markdown ?? '').matchAll(MEDIA_URI_RE)) {
    const uri = normalizeMediaUri(m[0]);
    if (!seen.has(uri)) { seen.add(uri); out.push(uri); }
  }
  return out;
}

/** 把正文里的 appdata 引用重写为 media/xxx（密码模式为 media/xxx.enc） */
function rewriteMarkdownMedia(markdown, fileByUri) {
  return String(markdown ?? '').replace(MEDIA_URI_RE, (raw) => {
    const uri = normalizeMediaUri(raw);
    const file = fileByUri.get(uri);
    return file ?? raw;
  });
}

// ────────────────────── 加密（契约「三」「三·补」） ──────────────────────

const b64 = (buf) => Buffer.from(buf).toString('base64');

function deriveKey(password, salt) {
  return pbkdf2Sync(Buffer.from(password, 'utf8'), salt, KDF_ITERATIONS, 32, 'sha256');
}

/** AES-256-GCM 加密，返回 iv(12B) || ciphertext || tag(16B) */
function gcmEncrypt(key, plaintext, iv) {
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([iv, body, c.getAuthTag()]);
}

/** 解 iv(12B) || ciphertext || tag(16B)，失败抛错 */
function gcmDecrypt(key, packed) {
  if (packed.length < GCM_IV_BYTES + GCM_TAG_BYTES) fail('密文长度不足，无法解密');
  const iv = packed.subarray(0, GCM_IV_BYTES);
  const body = packed.subarray(GCM_IV_BYTES, packed.length - GCM_TAG_BYTES);
  const tag = packed.subarray(packed.length - GCM_TAG_BYTES);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]);
}

/** 读已有 diaries.enc.json，拿到可复用的 salt / iv（复用 iv 只为「内容未变则字节相同」） */
function readExistingEnvelope(file) {
  if (!existsSync(file)) return null;
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    if (j && typeof j.salt === 'string' && typeof j.iv === 'string') {
      return {
        salt: Buffer.from(j.salt, 'base64'),
        iv: Buffer.from(j.iv, 'base64'),
        iterations: Number(j.iterations) || KDF_ITERATIONS,
      };
    }
  } catch { /* 损坏则当作不存在 */ }
  return null;
}

// ────────────────────── 配置与参数 ──────────────────────

function parseArgs(argv) {
  const o = {
    mode: 'local',
    zip: process.env.DIARY_ZIP || null,
    dir: null,
    out: DEFAULT_REPO_ROOT,
    includePrivate: false,
    dryRun: false,
    list: false,
    plain: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) fail(`参数 ${a} 缺少值`); return v; };
    switch (a) {
      case '--local': o.mode = 'local'; break;
      case '--webdav': o.mode = 'webdav'; break;
      case '--zip': o.zip = next(); break;
      case '--dir': o.dir = next(); break;
      case '--out': o.out = path.resolve(next()); break;
      case '--include-private': o.includePrivate = true; break;
      case '--plain': o.plain = true; break; // 强制明文模式（忽略 config.json 里的 password）
      case '--dry-run': o.dryRun = true; break;
      case '--list': o.list = true; break;
      case '--verbose': case '-v': VERBOSE = true; break;
      case '--help': case '-h': o.help = true; break;
      default: fail(`未知参数：${a}`, '用 --help 查看可用参数');
    }
  }
  return o;
}

export function loadConfig() {
  const file = path.join(TOOLS_DIR, 'config.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    fail(`tools/config.json 不是合法 JSON：${e.message}`);
  }
}

export function resolveSettings(args) {
  const cfg = loadConfig();
  const wd = cfg.webdav ?? {};
  const password = args.plain
    ? ''
    : ((process.env.DIARY_PASSWORD ?? '').trim() || (typeof cfg.password === 'string' ? cfg.password.trim() : ''));
  const s = {
    password,
    localDir: args.dir || process.env.DIARY_LOCAL_DIR || cfg.localDir ||
      path.join(process.env.USERPROFILE || process.env.HOME || '.', 'Nutstore', '1', 'SwashbucklerDiary'),
    webdavUrl: (process.env.DIARY_WEBDAV_URL || wd.url || 'https://dav.jianguoyun.com/dav/').trim(),
    webdavUser: (process.env.JIANGUO_USER || wd.user || '').trim(),
    webdavPass: (process.env.JIANGUO_PASS || wd.pass || '').trim(),
    webdavDir: (process.env.DIARY_WEBDAV_DIR || wd.dir || '我的坚果云/SwashbucklerDiary').trim(),
    includePrivate: args.includePrivate ||
      /^(1|true|yes)$/i.test(process.env.DIARY_INCLUDE_PRIVATE ?? '') ||
      cfg.includePrivate === true,
  };
  return s;
}

// ────────────────────── 数据源 ──────────────────────

function pickLatestLocalZip(dir) {
  if (!existsSync(dir)) {
    fail(`本机备份目录不存在：${dir}`,
      '确认坚果云已同步到本机；或用 --dir 指定目录，或改 tools/config.json 的 localDir');
  }
  const cands = readdirSync(dir)
    .filter((f) => BACKUP_NAME_RE.test(f))
    .map((f) => {
      const abs = path.join(dir, f);
      return { file: abs, name: f, stamp: BACKUP_NAME_RE.exec(f)[1], v: BACKUP_NAME_RE.exec(f)[2], size: statSync(abs).size };
    })
    .sort((a, b) => b.stamp.localeCompare(a.stamp)); // 文件名时间戳倒序
  if (!cands.length) fail(`${dir} 下没有 SwashbucklerDiaryBackup_*.zip`, '先在手机 App 里做一次 WebDAV 备份并等坚果云同步到本机');
  vlog('本机候选 zip：', cands.map((c) => c.name).join(', '));
  return cands[0];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(label, fn, { retries = 3, baseDelay = 800 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const retriable = e.retriable !== false;
      if (!retriable || attempt === retries) break;
      const delay = Math.round(baseDelay * 2 ** (attempt - 1) * (0.7 + Math.random() * 0.6));
      warn(`[重试 ${attempt}/${retries - 1}] ${label} 失败：${e.message}；${delay}ms 后重试`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

function buildWebdavUrl(base, dir) {
  const b = base.endsWith('/') ? base : `${base}/`;
  if (!dir) return b;
  const segs = dir.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
    .map((s) => (/%[0-9A-Fa-f]{2}/.test(s) ? s : encodeURIComponent(s)));
  return b + segs.join('/') + '/';
}

function xmlUnescape(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&');
}

function explainHttpStatus(status, what) {
  if (status === 401) return '账号或应用密码错误（坚果云要用「应用密码」，不是登录密码）';
  if (status === 403) return '权限不足或被拒绝（坚果云可能是请求配额用尽）';
  if (status === 404) return `${what} 不存在：检查 DIARY_WEBDAV_DIR 是否写对（用 --list 看根目录）`;
  if (status === 405) return '方法不被接受（服务器地址末尾要有 /）';
  if (status === 429 || status === 507) return '请求过快或配额超限：降低 cron 频率后重试';
  if (status >= 500) return '服务端错误（可重试）';
  return '';
}

async function webdavPropfind(url, auth, depth = 1) {
  const body = '<?xml version="1.0" encoding="utf-8"?>' +
    '<d:propfind xmlns:d="DAV:"><d:prop>' +
    '<d:displayname/><d:getcontentlength/><d:getlastmodified/><d:resourcetype/>' +
    '</d:prop></d:propfind>';
  const res = await fetch(url, {
    method: 'PROPFIND',
    headers: {
      Authorization: `Basic ${Buffer.from(`${auth.user}:${auth.pass}`, 'utf8').toString('base64')}`,
      Depth: String(depth),
      'Content-Type': 'application/xml; charset=utf-8',
      Accept: 'application/xml, text/xml, */*',
      'User-Agent': 'jialejunzi.xyz-diary-sync/1.0',
    },
    body,
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok && res.status !== 207) {
    const hint = explainHttpStatus(res.status, 'WebDAV 目录');
    const err = new Error(`PROPFIND ${res.status} ${res.statusText} ${url}${hint ? ` — ${hint}` : ''}`);
    err.retriable = res.status >= 500 || res.status === 429 || res.status === 408;
    throw err;
  }
  return res.text();
}

/** 用正则解析 PROPFIND 的 multistatus（命名空间前缀可能是 d: / lp1: / 无） */
function parsePropfindHrefs(xml) {
  const out = [];
  const re = /<(?:[A-Za-z0-9_.\-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.\-]+:)?response>/gi;
  for (const m of xml.matchAll(re)) {
    const block = m[1];
    const hrefM = /<(?:[A-Za-z0-9_.\-]+:)?href[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.\-]+:)?href>/i.exec(block);
    if (!hrefM) continue;
    const href = xmlUnescape(hrefM[1]).trim();
    const isDir = /<(?:[A-Za-z0-9_.\-]+:)?collection\s*\/?>/i.test(block);
    const lenM = /<(?:[A-Za-z0-9_.\-]+:)?getcontentlength[^>]*>(\d+)</i.exec(block);
    out.push({ href, isDir, length: lenM ? Number(lenM[1]) : null });
  }
  return out;
}

function hrefBasename(href) {
  const seg = href.replace(/\/+$/, '').split('/').pop() ?? '';
  try { return decodeURIComponent(seg); } catch { return seg; }
}

/** href 可能是绝对路径或完整 URL；保留其原始百分号编码用于 GET */
function resolveHref(requestUrl, href) {
  if (/^https?:\/\//i.test(href)) return href;
  return new URL(href, requestUrl).toString();
}

async function pickLatestWebdavZip(settings, { listOnly = false } = {}) {
  const { webdavUrl, webdavUser, webdavPass, webdavDir } = settings;
  if (!webdavUser || !webdavPass) {
    fail('WebDAV 模式缺少账号或应用密码',
      '设置环境变量 JIANGUO_USER / JIANGUO_PASS（坚果云用应用密码），或写在 tools/config.json 的 webdav.user / webdav.pass');
  }
  const auth = { user: webdavUser, pass: webdavPass };
  const url = buildWebdavUrl(webdavUrl, webdavDir);
  log(`[webdav] PROPFIND ${url}`);

  let xml;
  try {
    xml = await withRetry(`PROPFIND ${url}`, () => webdavPropfind(url, auth, 1));
  } catch (e) {
    if (listOnly) {
      // 目录不存在时退一步列根目录，方便排查
      warn(`[webdav] 目标目录列举失败：${e.message}`);
      const rootUrl = buildWebdavUrl(webdavUrl, '');
      log(`[webdav] 退回列根目录 ${rootUrl}`);
      xml = await withRetry(`PROPFIND ${rootUrl}`, () => webdavPropfind(rootUrl, auth, 1));
      printListing(parsePropfindHrefs(xml));
      return null;
    }
    throw e;
  }

  const items = parsePropfindHrefs(xml);
  if (listOnly) { printListing(items); }

  const zips = items
    .filter((it) => !it.isDir && !it.href.endsWith('/'))
    .map((it) => ({ ...it, base: hrefBasename(it.href) }))
    .filter((it) => BACKUP_NAME_RE.test(it.base))
    .map((it) => ({ ...it, stamp: BACKUP_NAME_RE.exec(it.base)[1], v: BACKUP_NAME_RE.exec(it.base)[2] }))
    .sort((a, b) => b.stamp.localeCompare(a.stamp));

  if (listOnly) return null;
  vlog('WebDAV 候选 zip：', zips.map((z) => z.base).join(', ') || '(无)');
  if (!zips.length) {
    fail(`${url} 下没有 SwashbucklerDiaryBackup_*.zip`,
      '先在手机 App 里「设置 → 备份 → WebDAV → 上传」做一次备份；再用 --list 确认目录');
  }
  const best = zips[0];
  return { file: resolveHref(url, best.href), name: best.base, stamp: best.stamp, v: best.v, size: best.length };
}

function printListing(items) {
  log(`[webdav] 目录共 ${items.length} 项：`);
  for (const it of items.slice(0, 200)) {
    log(`  ${it.isDir ? 'DIR ' : 'FILE'}  ${it.length != null ? String(it.length).padStart(10) : '          '}  ${hrefBasename(it.href)}`);
  }
  if (items.length > 200) log(`  …（仅显示前 200 项）`);
}

async function downloadWebdavFile(zipInfo, settings, destDir) {
  const auth = { user: settings.webdavUser, pass: settings.webdavPass };
  const buf = await withRetry(`GET ${zipInfo.name}`, async () => {
    const res = await fetch(zipInfo.file, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${auth.user}:${auth.pass}`, 'utf8').toString('base64')}`,
        'User-Agent': 'jialejunzi.xyz-diary-sync/1.0',
      },
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) {
      const hint = explainHttpStatus(res.status, '备份文件');
      const err = new Error(`GET ${res.status} ${res.statusText}${hint ? ` — ${hint}` : ''}`);
      err.retriable = res.status >= 500 || res.status === 429 || res.status === 408;
      throw err;
    }
    return Buffer.from(await res.arrayBuffer());
  });
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) {
    fail('下载到的内容不是 zip（可能被网关/登录页替换）',
      '检查 JIANGUO_USER / JIANGUO_PASS 是否为坚果云「应用密码」，以及 DIARY_WEBDAV_DIR');
  }
  mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, zipInfo.name);
  writeFileSync(dest, buf);
  log(`[webdav] 已下载 ${zipInfo.name}（${(buf.length / 1024).toFixed(1)} KB）`);
  return dest;
}

// ────────────────────── db3 读取 ──────────────────────

async function loadSqlite() {
  let mod;
  try {
    mod = await import('node:sqlite');
  } catch {
    fail(`当前 Node（${process.version}）没有内置 node:sqlite`,
      '升级到 Node ≥ 22.5（推荐 24），或降级方案：本机用 python 读 db3 导出 JSON 后再喂给本脚本；CI 里 actions/setup-node 指定 node-version: 24');
  }
  if (!mod.DatabaseSync) fail('node:sqlite 里找不到 DatabaseSync，Node 版本过旧', '升级到 Node ≥ 22.5');
  return mod.DatabaseSync;
}

function readDiaryRows(DatabaseSync, dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    const cols = new Set(db.prepare('PRAGMA table_info("DiaryModel")').all().map((c) => c.name));
    if (!cols.size) fail('备份里没有 DiaryModel 表，可能不是侠客日记的 db3');
    for (const need of ['Id', 'Content', 'CreateTime']) {
      if (!cols.has(need)) fail(`DiaryModel 缺少必需列 ${need}`);
    }
    const diaries = db.prepare(
      'SELECT Id, Title, Content, Mood, Weather, Location, Top, Private, Template, CreateTime, UpdateTime FROM DiaryModel'
    ).all();
    const tags = db.prepare('SELECT Id, Name FROM TagModel').all();
    const diaryTags = db.prepare('SELECT DiaryId, TagId FROM DiaryTagModel').all();
    const diaryResources = db.prepare('SELECT DiaryId, ResourceUri FROM DiaryResourceModel').all();
    return { diaries, tags, diaryTags, diaryResources };
  } finally {
    db.close();
  }
}

// ────────────────────── 生成契约 JSON ──────────────────────

function buildDocument({ rows, version, generatedAt, includePrivate, passwordMode, mediaIndex }) {
  const { diaries, tags, diaryTags, diaryResources } = rows;

  const tagNameById = new Map(tags.map((t) => [t.Id, (t.Name ?? '').trim()]).filter(([, n]) => n));
  const tagsByDiary = new Map();
  for (const dt of diaryTags) {
    const name = tagNameById.get(dt.TagId);
    if (!name) continue;
    if (!tagsByDiary.has(dt.DiaryId)) tagsByDiary.set(dt.DiaryId, []);
    const arr = tagsByDiary.get(dt.DiaryId);
    if (!arr.includes(name)) arr.push(name);
  }
  const resByDiary = new Map();
  for (const dr of diaryResources) {
    if (!dr.ResourceUri) continue;
    const uri = normalizeMediaUri(String(dr.ResourceUri));
    if (!resByDiary.has(dr.DiaryId)) resByDiary.set(dr.DiaryId, []);
    resByDiary.get(dr.DiaryId).push(uri);
  }

  // uri → 输出文件名（密码模式带 .enc）
  const fileByUri = new Map();
  for (const [uri, info] of mediaIndex) fileByUri.set(uri, info.file);

  const kept = diaries
    .filter((d) => includePrivate || !Number(d.Private))
    .slice()
    .sort((a, b) => {
      const ta = normalizeDbTime(a.CreateTime);
      const tb = normalizeDbTime(b.CreateTime);
      if (ta !== tb) return tb.localeCompare(ta); // 契约规则 1：倒序
      return String(a.Id).localeCompare(String(b.Id)); // 保证确定性
    });

  const tagCounts = {};
  let mediaRefCount = 0;
  const entries = kept.map((d) => {
    const createTime = normalizeDbTime(d.CreateTime);
    const updateTime = normalizeDbTime(d.UpdateTime) || createTime;
    const rawContent = String(d.Content ?? '').replace(/\r\n?/g, '\n'); // 契约规则 7

    // 正文引用 ∪ 资源表引用（保序去重）
    const uriList = extractMediaUris(rawContent);
    for (const uri of resByDiary.get(d.Id) ?? []) if (!uriList.includes(uri)) uriList.push(uri);

    const markdown = rewriteMarkdownMedia(rawContent, fileByUri);
    const plain = toPlainText(markdown);
    const diaryTagList = tagsByDiary.get(d.Id) ?? [];
    for (const t of diaryTagList) tagCounts[t] = (tagCounts[t] ?? 0) + 1;

    const media = uriList.map((uri) => {
      mediaRefCount++;
      const info = mediaIndex.get(uri);
      return {
        uri,
        file: info ? info.file : `${passwordMode ? `${mediaBasename(uri)}.enc` : mediaBasename(uri)}`,
        exists: Boolean(info && info.exists),
        encrypted: passwordMode,
      };
    });

    return {
      id: String(d.Id),
      createTime,
      updateTime,
      date: createTime.slice(0, 10),
      year: createTime ? Number(createTime.slice(0, 4)) : 0,
      month: createTime.slice(0, 7),
      time: createTime.slice(11, 16),
      title: firstLineTitle(plain),
      excerpt: makeExcerpt(plain),
      markdown,
      tags: diaryTagList,
      mood: d.Mood ?? '',
      weather: d.Weather ?? '',
      location: d.Location ?? '',
      top: Boolean(Number(d.Top)),
      words: countWords(plain),
      media,
    };
  });

  const sortedTagCounts = {};
  for (const k of Object.keys(tagCounts).sort()) sortedTagCounts[k] = tagCounts[k];

  return {
    doc: {
      schema: SCHEMA,
      generatedAt,
      source: version ? `SwashbucklerDiary v${version}` : 'SwashbucklerDiary',
      count: entries.length,
      encrypted: passwordMode,
      tags: sortedTagCounts,
      entries,
    },
    stats: { mediaRefCount },
  };
}

// ────────────────────── 幂等写入 ──────────────────────

const writeResult = { written: [], unchanged: [], removed: [] };

function writeIfChanged(file, content, { dryRun }) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  if (existsSync(file)) {
    const old = readFileSync(file);
    if (old.equals(buf)) { writeResult.unchanged.push(file); return false; }
  }
  if (!dryRun) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, buf);
  }
  writeResult.written.push(file);
  return true;
}

function removeIfExists(file, { dryRun, reason }) {
  if (!existsSync(file)) return false;
  if (!dryRun) unlinkSync(file);
  writeResult.removed.push(`${file}${reason ? `（${reason}）` : ''}`);
  return true;
}

// ────────────────────── 差异统计 ──────────────────────

function diffEntries(prevFile, entries) {
  if (!existsSync(prevFile)) return { first: true, added: entries.length, removed: 0, changed: 0 };
  try {
    const prev = JSON.parse(readFileSync(prevFile, 'utf8'));
    if (!Array.isArray(prev.entries)) return { unknown: true, added: 0, removed: 0, changed: 0 };
    const prevMap = new Map(prev.entries.map((e) => [e.id, JSON.stringify(e)]));
    const nextMap = new Map(entries.map((e) => [e.id, JSON.stringify(e)]));
    let added = 0, removed = 0, changed = 0;
    for (const [id, json] of nextMap) {
      if (!prevMap.has(id)) added++;
      else if (prevMap.get(id) !== json) changed++;
    }
    for (const id of prevMap.keys()) if (!nextMap.has(id)) removed++;
    return { added, removed, changed };
  } catch {
    return { unknown: true, added: 0, removed: 0, changed: 0 };
  }
}

// ────────────────────── 主流程 ──────────────────────

/**
 * 生成日记数据 + 媒体。build-site.mjs 直接复用本函数（不要复制逻辑）。
 * @param {string[]} argv 例如 ['--webdav'] 或 ['--local','--dir','D:\\x']
 * @returns {Promise<{status:'help'|'listed'|'ok', summary?:object}>}
 */
export async function generateDiary(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, '')); return { status: 'help' }; }

  writeResult.written = []; writeResult.unchanged = []; writeResult.removed = [];
  const settings = resolveSettings(args);
  const repoRoot = args.out;
  const dataDir = path.join(repoRoot, 'diary', 'data');
  const mediaDir = path.join(repoRoot, 'diary', 'media');
  const passwordMode = Boolean(settings.password);

  log(`=== sync-diary ===  模式：${args.mode === 'webdav' ? 'WebDAV（坚果云）' : '本机目录'}｜输出：${passwordMode ? '密码模式（密文）' : '明文模式'}${args.dryRun ? '｜DRY-RUN' : ''}`);

  // 1) 取 zip
  let zipPath = args.zip ? path.resolve(args.zip) : null;
  let zipInfo;
  if (!zipPath && args.mode === 'webdav') {
    zipInfo = await pickLatestWebdavZip(settings, { listOnly: args.list });
    if (args.list) return { status: 'listed' };
    zipPath = await downloadWebdavFile(zipInfo, settings, path.join(tmpdir(), 'swashbuckler-diary-sync'));
  } else if (!zipPath) {
    zipInfo = pickLatestLocalZip(settings.localDir);
    zipPath = zipInfo.file;
  }
  if (!existsSync(zipPath)) fail(`找不到 zip：${zipPath}`);
  if (!zipInfo) {
    const base = path.basename(zipPath);
    const m = BACKUP_NAME_RE.exec(base);
    zipInfo = { file: zipPath, name: base, stamp: m ? m[1] : null, v: m ? m[2] : null };
  }
  log(`源文件：${zipPath}`);

  const zip = new ZipArchive(readFileSync(zipPath));

  // 2) 解析元信息
  const versionJson = zip.read('version.json');
  let version = zipInfo.v;
  let generatedAt = zipInfo.stamp ? isoFromStamp(zipInfo.stamp) : null;
  if (versionJson) {
    try {
      const vj = JSON.parse(versionJson.toString('utf8').replace(/^\uFEFF/, ''));
      version = vj.Version ?? version;
      generatedAt = normalizeIsoTime(vj.DateTime) ?? generatedAt;
    } catch (e) { warn(`version.json 解析失败，退回文件名推断：${e.message}`); }
  }
  if (versionJson) {
    try {
      const sj = JSON.parse(zip.read('settings.json')?.toString('utf8').replace(/^\uFEFF/, '') ?? '{}');
      vlog(`settings.WebDAVCopyResources=${sj.WebDAVCopyResources}`);
      if (sj.WebDAVCopyResources === false) {
        warn('提示：手机端 settings.json 里 WebDAVCopyResources=false，本次备份不含图片资源（见 tools/README.md「图片资源」）');
      }
    } catch { /* 忽略 */ }
  }
  if (!generatedAt) generatedAt = new Date().toISOString().replace(/\.\d+Z$/, '+00:00');

  // 3) 读 db3（node:sqlite 需要文件路径，先落到临时文件）
  const dbEntry = zip.find((e) => /\.db3$/i.test(e.name));
  if (!dbEntry) fail('zip 里找不到 .db3 数据库文件', '确认这是 SwashbucklerDiary 的备份 zip');
  const DatabaseSync = await loadSqlite();
  const tmpDir = path.join(tmpdir(), 'swashbuckler-diary-sync');
  mkdirSync(tmpDir, { recursive: true });
  const tmpDb = path.join(tmpDir, `${process.pid}-${Date.now()}-${path.basename(dbEntry.name)}`);
  writeFileSync(tmpDb, zip.readEntry(dbEntry));
  let rows;
  try {
    rows = readDiaryRows(DatabaseSync, tmpDb);
  } finally {
    try { rmSync(tmpDb, { force: true }); } catch { /* ignore */ }
  }
  log(`备份版本：v${version}｜备份时间：${generatedAt}｜库内日记：${rows.diaries.length} 篇（Private ${rows.diaries.filter((d) => Number(d.Private)).length} 篇）`);

  // 4) 媒体准备：找出 zip 里的资源，决定输出名
  const zipMediaByName = new Map();
  for (const e of zip.entries) if (/^(appdata|Image|Audio|Video)\//i.test(e.name)) zipMediaByName.set(e.name, e);

  const allUris = new Set();
  for (const d of rows.diaries) {
    if (!settings.includePrivate && Number(d.Private)) continue;
    for (const uri of extractMediaUris(String(d.Content ?? '').replace(/\r\n?/g, '\n'))) allUris.add(uri);
  }
  for (const dr of rows.diaryResources) {
    if (dr.ResourceUri) allUris.add(normalizeMediaUri(String(dr.ResourceUri)));
  }

  const masterKeyInfo = passwordMode ? readExistingEnvelope(path.join(dataDir, 'diaries.enc.json')) : null;
  const salt = passwordMode ? (masterKeyInfo?.salt ?? randomBytes(16)) : null;
  const key = passwordMode ? deriveKey(settings.password, salt) : null;

  const mediaIndex = new Map(); // uri → { file, exists, sourceBytes? }
  const mediaPlan = []; // 待写文件
  for (const uri of allUris) {
    const basename = mediaBasename(uri);
    const file = passwordMode ? `media/${basename}.enc` : `media/${basename}`;
    const srcBytes = resolveMediaBytes(zip, zipMediaByName, uri);
    mediaIndex.set(uri, { file, exists: false });
    if (srcBytes) mediaPlan.push({ uri, file, basename, srcBytes });
  }

  if (!args.dryRun) mkdirSync(mediaDir, { recursive: true });
  let mediaCopied = 0, mediaKept = 0;
  for (const item of mediaPlan) {
    const outFile = path.join(mediaDir, path.basename(item.file));
    if (passwordMode) {
      // 已有密文能解回同样内容 → 复用（幂等，且不重复消耗随机 iv）
      if (existsSync(outFile)) {
        try {
          const plain = gcmDecrypt(key, readFileSync(outFile));
          if (plain.equals(item.srcBytes)) { mediaKept++; mediaIndex.get(item.uri).exists = true; continue; }
        } catch { /* 旧密码或损坏 → 重写 */ }
      }
      const packed = gcmEncrypt(key, item.srcBytes, randomBytes(GCM_IV_BYTES));
      writeIfChanged(outFile, packed, { dryRun: args.dryRun });
      mediaCopied++;
      mediaIndex.get(item.uri).exists = true;
    } else {
      if (existsSync(outFile) && readFileSync(outFile).equals(item.srcBytes)) {
        mediaKept++;
        mediaIndex.get(item.uri).exists = true;
        continue;
      }
      writeIfChanged(outFile, item.srcBytes, { dryRun: args.dryRun });
      mediaCopied++;
      mediaIndex.get(item.uri).exists = true;
    }
  }
  const missingMedia = allUris.size - mediaPlan.length;

  // 清理不再引用 / 模式不匹配的媒体文件
  const expected = new Set(mediaPlan.map((m) => path.basename(m.file)));
  if (existsSync(mediaDir)) {
    for (const f of readdirSync(mediaDir)) {
      if (f === '.gitkeep' || expected.has(f)) continue;
      const isEnc = f.endsWith('.enc');
      const reason = isEnc && !passwordMode ? '明文模式不需要 .enc'
        : !isEnc && passwordMode ? '密码模式不允许明文媒体留在仓库'
          : '已不再被引用';
      removeIfExists(path.join(mediaDir, f), { dryRun: args.dryRun, reason });
    }
  }

  // 5) 生成文档
  const { doc, stats } = buildDocument({
    rows, version, generatedAt,
    includePrivate: settings.includePrivate,
    passwordMode, mediaIndex,
  });
  const plainJson = JSON.stringify(doc, null, 2) + '\n';
  const prevPlain = path.join(dataDir, 'diaries.json');
  const encFile = path.join(dataDir, 'diaries.enc.json');
  const diff = passwordMode
    ? { unknown: true, added: 0, removed: 0, changed: 0 }
    : diffEntries(prevPlain, doc.entries);

  // 6) 写出
  if (passwordMode) {
    // 先复用旧 iv：内容未变 → 字节完全相同 → 幂等；内容变了则换新 iv，避免同 key 同 nonce 复用
    const reusableIv = masterKeyInfo?.iv?.length === GCM_IV_BYTES ? masterKeyInfo.iv : null;
    let text = JSON.stringify(buildEnvelope(plainJson, key, salt, reusableIv ?? randomBytes(GCM_IV_BYTES), doc), null, 2) + '\n';
    if (reusableIv && existsSync(encFile) && text !== readFileSync(encFile, 'utf8')) {
      text = JSON.stringify(buildEnvelope(plainJson, key, salt, randomBytes(GCM_IV_BYTES), doc), null, 2) + '\n';
    }
    writeIfChanged(encFile, text, { dryRun: args.dryRun });
    const removedPlain = removeIfExists(prevPlain, { dryRun: args.dryRun, reason: '密码模式：明文不得留在仓库' });
    log(removedPlain
      ? `密码模式：已删除明文 ${path.relative(repoRoot, prevPlain)}，只保留密文`
      : `密码模式：只输出密文（${path.relative(repoRoot, encFile)}；明文不存在）`);
  } else {
    writeIfChanged(prevPlain, plainJson, { dryRun: args.dryRun });
    removeIfExists(encFile, { dryRun: args.dryRun, reason: '明文模式：清掉过期密文' });
  }

  // 7) 摘要
  const summary = {
    sourceZip: zipPath,
    version: version ?? null,
    generatedAt,
    count: doc.count,
    includePrivate: settings.includePrivate,
    passwordMode,
    dataFile: path.relative(repoRoot, passwordMode ? encFile : prevPlain),
    outputDir: repoRoot,
    diff,
    media: { referenced: allUris.size, written: mediaCopied, reused: mediaKept, missing: missingMedia },
    tags: doc.tags,
    words: doc.entries.reduce((s, e) => s + e.words, 0),
    written: writeResult.written.map((f) => path.relative(repoRoot, f)),
    unchanged: writeResult.unchanged.map((f) => path.relative(repoRoot, f)),
    removed: writeResult.removed.map((f) => path.relative(repoRoot, f)),
    dryRun: args.dryRun,
  };
  log('');
  log('── 摘要 ──');
  log(`日记：${doc.count} 篇${settings.includePrivate ? '（含 Private）' : '（已排除 Private）'}` +
    (diff.first ? '｜首次生成' : diff.unknown ? '｜上次输出为密文，跳过差异统计'
      : `｜新增 ${diff.added} / 删除 ${diff.removed} / 变更 ${diff.changed}`));
  log(`媒体：引用 ${allUris.size} 个 · 本次写入 ${mediaCopied} · 复用 ${mediaKept} · 缺失 ${missingMedia}` +
    (missingMedia ? '（zip 里没有这些资源：手机端未开启「包含媒体文件」）' : ''));
  log(`标签：${Object.entries(doc.tags).map(([k, v]) => `${k}(${v})`).join('、') || '无'}｜词数合计 ${summary.words}`);
  log(`输出：${writeResult.written.length ? `写入 ${writeResult.written.length} 个` : '无写入（内容未变）'}` +
    `${writeResult.unchanged.length ? `｜未变 ${writeResult.unchanged.length} 个` : ''}` +
    `${writeResult.removed.length ? `｜删除 ${writeResult.removed.length} 个` : ''}`);
  for (const f of writeResult.written) log(`  + ${f}`);
  for (const f of writeResult.removed) log(`  - ${f}`);
  if (args.dryRun) log('（dry-run：未真正写盘）');

  return { status: 'ok', summary };
}

function buildEnvelope(plainJson, key, salt, iv, doc) {
  const packed = gcmEncrypt(key, Buffer.from(plainJson, 'utf8'), iv);
  return {
    schema: SCHEMA,
    enc: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations: KDF_ITERATIONS,
    salt: b64(salt),
    iv: b64(iv),
    ciphertext: b64(packed.subarray(GCM_IV_BYTES)),
    hint: { count: doc.count, generatedAt: doc.generatedAt },
  };
}

/** 在 zip 里找某个 appdata uri 的原始字节 */
function resolveMediaBytes(zip, zipMediaByName, uri) {
  const want = uri.toLowerCase();
  const base = mediaBasename(uri).toLowerCase();
  // 1) 精确路径
  let e = zipMediaByName.get(uri) ?? null;
  // 2) 任意前缀（appdata/Image/x.jpg 可能被放在子目录里）
  if (!e) e = zip.find((x) => x.name.toLowerCase().endsWith(`/${want}`)) ?? null;
  // 3) 同 basename（兼容旧版本 Image/ 布局）
  if (!e) e = zip.find((x) => x.name.toLowerCase().endsWith(`/${base}`)) ?? null;
  if (!e) return null;
  try { return zip.readEntry(e); } catch (err) { warn(`媒体解压失败 ${e.name}：${err.message}`); return null; }
}

// ── CLI 入口：只有「直接运行本文件」时才执行；被 build-site.mjs import 时不执行 ──
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  generateDiary().catch((e) => {
    console.error('');
    console.error(`✗ 失败：${e.message}`);
    if (e.hint) console.error(`  建议：${e.hint}`);
    if (VERBOSE && e.stack) console.error(e.stack);
    process.exitCode = 1;
  });
}
