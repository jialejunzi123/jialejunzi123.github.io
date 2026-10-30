#!/usr/bin/env node
/**
 * build-site.mjs — 组装 GitHub Pages 生产产物 `_site/`
 *
 * 方案 B（见 diary-contract.md「三·补三」）：日记数据不进仓库，
 * 由 GitHub Actions 现场拉取坚果云 WebDAV → 生成密文 → 和静态站文件一起打包成 _site/ → 上传 Pages artifact。
 *
 * 用法：
 *   node tools/build-site.mjs --webdav        # 生产（CI 用）
 *   node tools/build-site.mjs --local         # 本机：坚果云本机目录 + 本机预览
 *   node tools/build-site.mjs --local --out D:\preview
 *   node tools/build-site.mjs --webdav --tolerate-diary-error
 *
 * 关键约束：
 *   - 缺 JIANGUO_USER / JIANGUO_PASS 时不失败：跳过日记数据、照常发布静态站（/diary/ 显示空态），退出码 0。
 *   - 绝不往仓库写任何东西；产物只在 _site/（已 gitignore）。
 *   - 日记生成逻辑全部复用 sync-diary.mjs 的 generateDiary()，不复制第二份。
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { generateDiary, loadConfig, resolveSettings } from './sync-diary.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// 不进 _site 的目录（仓库自有 / 构建产物 / 非站点资源）
const EXCLUDE_DIRS = new Set(['.git', '.github', 'tools', '_site', 'report', 'node_modules', '.vscode', '.idea', 'tmp', 'node']);
// 不进 _site 的文件（按 basename 判断）
const EXCLUDE_FILES = /^(?:\..*|.*\.md|.*\.zip|.*\.log|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i;
// 日记数据目录：由生成器现写，不从仓库复制
const DIARY_DATA_DIRS = new Set(['diary/data', 'diary/media']);

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);
let VERBOSE = false;
const vlog = (...a) => { if (VERBOSE) console.log('[debug]', ...a); };

function parseArgs(argv) {
  const o = {
    mode: 'webdav',
    zip: process.env.DIARY_ZIP || null,
    dir: null,
    out: path.join(REPO_ROOT, '_site'),
    includePrivate: false,
    dryRun: false,
    list: false,
    plain: false,
    tolerateDiaryError: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`参数 ${a} 缺少值`); return v; };
    switch (a) {
      case '--webdav': o.mode = 'webdav'; break;
      case '--local': o.mode = 'local'; break;
      case '--zip': o.zip = next(); break;
      case '--dir': o.dir = next(); break;
      case '--out': o.out = path.resolve(next()); break;
      case '--include-private': o.includePrivate = true; break;
      case '--plain': o.plain = true; break;
      case '--dry-run': o.dryRun = true; break;
      case '--list': o.list = true; break;
      case '--tolerate-diary-error': o.tolerateDiaryError = true; break;
      case '--verbose': case '-v': VERBOSE = true; break;
      case '--help': case '-h': o.help = true; break;
      default: throw new Error(`未知参数：${a}`);
    }
  }
  return o;
}

function shouldSkip(rel) {
  const segs = rel.split(path.sep);
  if (segs.some((s) => EXCLUDE_DIRS.has(s))) return true;
  if (DIARY_DATA_DIRS.has(rel.split(path.sep).join('/'))) return true;
  if (EXCLUDE_FILES.test(path.basename(rel))) return true;
  return false;
}

/** 复制静态站文件（递归，带排除表），返回复制清单 */
function copyStatic(srcRoot, destRoot, rel = '') {
  const out = [];
  const abs = rel ? path.join(srcRoot, rel) : srcRoot;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const childRel = rel ? path.join(rel, entry.name) : entry.name;
    if (shouldSkip(childRel)) { vlog('跳过', childRel); continue; }
    const childAbs = path.join(abs, entry.name);
    if (entry.isDirectory()) {
      out.push(...copyStatic(srcRoot, destRoot, childRel));
    } else if (entry.isFile()) {
      const dest = path.join(destRoot, childRel);
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(childAbs, dest);
      out.push(childRel.split(path.sep).join('/'));
    }
  }
  return out;
}

function dirStats(dir) {
  let files = 0, bytes = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { files++; bytes += statSync(p).size; }
    }
  };
  if (existsSync(dir)) walk(dir);
  return { files, bytes };
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 检查取数所需凭据，返回缺失的 secret 名列表 */
function missingCredentials() {
  const cfg = loadConfig();
  const wd = cfg.webdav ?? {};
  const missing = [];
  if (!(process.env.JIANGUO_USER || wd.user)) missing.push('JIANGUO_USER');
  if (!(process.env.JIANGUO_PASS || wd.pass)) missing.push('JIANGUO_PASS');
  return missing;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    log('用法：node tools/build-site.mjs [--webdav|--local] [--out DIR] [--plain] [--tolerate-diary-error] [--verbose]');
    return;
  }
  VERBOSE = args.verbose;

  log(`=== build-site ===  数据源：${args.mode === 'webdav' ? 'WebDAV（坚果云）' : '本机目录'}｜产物：${args.out}${args.dryRun ? '｜DRY-RUN' : ''}`);

  // 1) 清空并准备 _site
  if (!args.dryRun) {
    rmSync(args.out, { recursive: true, force: true });
    mkdirSync(args.out, { recursive: true });
  }

  // 2) 复制静态站文件
  const copied = copyStatic(REPO_ROOT, args.out);
  log(`静态站文件：复制 ${copied.length} 个`);
  for (const f of copied.sort()) log(`  · ${f}`);
  const required = ['index.html', 'diary/index.html', 'CNAME'];
  const missingStatic = required.filter((r) => !copied.includes(r));
  if (missingStatic.length) {
    warn(`⚠ 静态文件缺失：${missingStatic.join(' / ')}（前端队友可能还没产出，先继续）`);
  }

  // 3) 现生成日记数据（复用 sync-diary 的逻辑）
  let diarySkipped = null;
  let diaryResult = null;
  const settings = resolveSettings({ plain: args.plain, dir: args.dir, includePrivate: args.includePrivate });
  const allowPlaintext = /^(1|true|yes)$/i.test(process.env.DIARY_ALLOW_PLAINTEXT ?? '');

  if (args.mode === 'webdav') {
    const miss = missingCredentials();
    if (miss.length) {
      diarySkipped = `缺少 ${miss.join(' / ')}`;
    } else if (!settings.password && !allowPlaintext) {
      // 生产路径绝不允许把明文日记公网发布出去（方案 B 的核心前提）。
      // 想看空态/或确实想公开明文，就显式加 DIARY_ALLOW_PLAINTEXT=1。
      diarySkipped = '缺少 DIARY_PASSWORD（生产构建不允许输出明文日记）';
    }
  } else if (args.zip) {
    if (!existsSync(path.resolve(args.zip))) diarySkipped = `找不到 zip：${args.zip}`;
  } else {
    const dir = args.dir || process.env.DIARY_LOCAL_DIR;
    const fallback = path.join(process.env.USERPROFILE || process.env.HOME || '.', 'Nutstore', '1', 'SwashbucklerDiary');
    const scanDir = dir || fallback;
    if (!dir && !existsSync(scanDir)) diarySkipped = `本机备份目录不存在：${scanDir}`;
  }

  if (diarySkipped) {
    warn('');
    warn(`⚠ 跳过日记数据：${diarySkipped}`);
    warn('  静态站照常发布，/diary/ 会显示「暂无日记」空态。');
    if (args.mode === 'webdav') {
      warn('  修复：仓库 Settings → Secrets and variables → Actions → New repository secret，添加：');
      warn('    JIANGUO_USER      坚果云登录邮箱');
      warn('    JIANGUO_PASS      坚果云「应用密码」（不是登录密码）');
      warn('    DIARY_PASSWORD    站点解密密码（必填：没它就不会发布任何日记数据，避免明文外泄）');
      warn('    DIARY_WEBDAV_DIR  WebDAV 目录，默认 我的坚果云/SwashbucklerDiary');
      if (String(diarySkipped).includes('DIARY_PASSWORD')) {
        warn('  仅当确实想公开明文日记时才设 DIARY_ALLOW_PLAINTEXT=1 强制覆盖（不建议）。');
      }
    }
    if (process.env.GITHUB_ACTIONS) warn(`::warning title=日记数据已跳过::${diarySkipped}`);
  } else {
    const genArgv = [args.mode === 'webdav' ? '--webdav' : '--local'];
    genArgv.push('--out', args.out);
    if (args.dir) genArgv.push('--dir', args.dir);
    if (args.zip) genArgv.push('--zip', args.zip);
    if (args.includePrivate) genArgv.push('--include-private');
    if (args.plain) genArgv.push('--plain');
    if (args.list) genArgv.push('--list');
    if (args.dryRun) genArgv.push('--dry-run');
    if (args.verbose) genArgv.push('--verbose');

    try {
      diaryResult = await generateDiary(genArgv);
    } catch (e) {
      if (!args.tolerateDiaryError) throw e;
      warn('');
      warn(`⚠ 日记生成失败（已按 --tolerate-diary-error 继续发布静态站）：${e.message}`);
      if (e.hint) warn(`  建议：${e.hint}`);
      if (process.env.GITHUB_ACTIONS) warn(`::warning title=日记生成失败::${e.message}`);
      diarySkipped = e.message;
    }
  }

  // 4) 数据目录就位（即使跳过也要存在，让 /diary/ 走空态而不是路径 404）
  if (!args.dryRun) {
    mkdirSync(path.join(args.out, 'diary', 'data'), { recursive: true });
    mkdirSync(path.join(args.out, 'diary', 'media'), { recursive: true });
  }

  // 5) 摘要
  const st = dirStats(args.out);
  log('');
  log('── _site 摘要 ──');
  log(`产物目录：${args.out}`);
  log(`文件总数：${st.files} 个｜合计 ${fmtBytes(st.bytes)}`);
  if (diaryResult?.status === 'ok') {
    const s = diaryResult.summary;
    log(`日记数据：${s.dataFile}（${s.count} 篇｜${s.passwordMode ? '密文（密码模式）' : '⚠ 明文模式'}）`);
    log(`媒体：引用 ${s.media.referenced} · 写入 ${s.media.written} · 复用 ${s.media.reused} · 缺失 ${s.media.missing}`);
    if (!s.passwordMode) {
      warn('⚠ 当前是明文模式（DIARY_ALLOW_PLAINTEXT=1 或本机 --local/--plain）：diaries.json 会随站点公开。');
      if (process.env.GITHUB_ACTIONS) warn('::warning title=日记为明文模式::产物含明文 diaries.json（已显式允许）');
    }
  } else if (diaryResult?.status === 'help' || diaryResult?.status === 'listed') {
    log('日记数据：未生成（--help/--list）');
  } else {
    log(`日记数据：已跳过（${diarySkipped ?? '未知原因'}）`);
  }
  log(`CNAME：${existsSync(path.join(args.out, 'CNAME')) ? '已包含' : '⚠ 缺失'}`);
  if (args.dryRun) log('（dry-run：未真正写盘）');
  log('完成。');
}

main().catch((e) => {
  console.error('');
  console.error(`✗ build-site 失败：${e.message}`);
  if (e.hint) console.error(`  建议：${e.hint}`);
  if (VERBOSE && e.stack) console.error(e.stack);
  process.exitCode = 1;
});
