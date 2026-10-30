#!/usr/bin/env node
/**
 * check-plaintext-leak.mjs —— 明文泄漏自查（防回归守卫）
 *
 * 背景：本仓库承诺"公开仓库里搜不到任何日记明文"。这条承诺很容易被自己破坏——
 * 例如在文档里拿一句真实日记原文当 grep 示例，就把明文写进了仓库。
 * 本脚本用真实数据反查：
 *   1) 解出 diary/data/diaries.enc.json（密码取 DIARY_PASSWORD 或 tools/config.json）
 *   2) 从 title / excerpt / markdown 归一化后切 10 字窗口，只保留「含 ≥4 个中日韩字符」的窗口
 *      （泄漏的形态是"散文被抄进仓库"；纯 ASCII 技术串不算，否则会误报一大堆）
 *   3) 减去基线：改动前就有的站点文件（README.md / CNAME / index.html / diary/*），其词汇属于站点自有词汇
 *   4) 扫「将会被提交的文件」（git ls-files -co --exclude-standard），逐个滑窗比对
 *
 * 输出默认**脱敏**（只给文件、行号、片段长度），因为公开仓库的 CI 日志是公开的；
 * 想看到原文用 --show（只在本机调试时用，别把输出贴进任何文件）。
 *
 * 用法：
 *   node tools/check-plaintext-leak.mjs            # 自查（无密码/无数据时跳过，退出码 0）
 *   node tools/check-plaintext-leak.mjs --show     # 本机调试：打印命中的原文片段
 *   node tools/check-plaintext-leak.mjs --quiet    # 只在有问题时输出
 *
 * 退出码：0 = 干净（或跳过）；1 = 发现泄漏
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

const WINDOW = 10;   // 指纹窗口长度
const MIN_CJK = 4;   // 窗口中至少这么多个中日韩字符才算"散文型指纹"

// 基线：这些文件在日记功能之前就存在，其词汇属于站点自有词汇，不算泄漏
const BASELINE = ['README.md', 'CNAME', 'index.html', 'diary/index.html', 'diary/diary.js', 'diary/diary.css', 'diary/vendor/marked.min.js'];

const norm = (s) => String(s ?? '').replace(/\s+/g, '');
const cjkCount = (s) => (s.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
const windowsOf = (t) => {
  const out = [];
  for (let i = 0; i + WINDOW <= t.length; i++) out.push(t.slice(i, i + WINDOW));
  return out;
};

const args = new Set(process.argv.slice(2));
const SHOW = args.has('--show');
const QUIET = args.has('--quiet');
const say = (...a) => { if (!QUIET) console.log(...a); };

/** 解开发日记密文（独立实现，日常守卫不该依赖生成器内部） */
function decryptDiaries(envFile, password) {
  const env = JSON.parse(readFileSync(envFile, 'utf8'));
  if (env.enc !== 'AES-256-GCM') throw new Error(`信封算法不符：${env.enc}`);
  const salt = Buffer.from(env.salt, 'base64');
  const iv = Buffer.from(env.iv, 'base64');
  const ct = Buffer.from(env.ciphertext, 'base64');
  const key = pbkdf2(password, salt, Number(env.iterations) || 200000);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(ct.subarray(ct.length - 16));
  return JSON.parse(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString('utf8'));
}

/** PBKDF2-SHA256 → 32B 主密钥（与生成器/前端同一套参数） */
function pbkdf2(password, salt, iterations) {
  return pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
}

function resolvePassword() {
  if (process.env.DIARY_PASSWORD && process.env.DIARY_PASSWORD.trim()) return process.env.DIARY_PASSWORD.trim();
  const cfgFile = path.join(__dirname, 'config.json');
  if (existsSync(cfgFile)) {
    try {
      const pw = JSON.parse(readFileSync(cfgFile, 'utf8')).password;
      if (pw && String(pw).trim()) return String(pw).trim();
    } catch { /* ignore */ }
  }
  return null;
}

function gitFiles() {
  try {
    return execFileSync('git', ['ls-files', '-co', '--exclude-standard', '--deduplicate'],
      { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function main() {
  const password = resolvePassword();
  const envFile = path.join(REPO, 'diary', 'data', 'diaries.enc.json');
  if (!password || !existsSync(envFile)) {
    say(`跳过：${!password ? '没有密码（DIARY_PASSWORD / tools/config.json）' : '没有 diary/data/diaries.enc.json'}`);
    say('（这是正常情况：CI 首次构建、或还没生成过日记数据时无从比对）');
    return 0;
  }

  // 基线窗口
  const baseline = new Set();
  for (const f of BASELINE) {
    const abs = path.join(REPO, f);
    if (existsSync(abs)) for (const w of windowsOf(norm(readFileSync(abs, 'utf8')))) baseline.add(w);
  }

  const doc = decryptDiaries(envFile, password);
  const prints = new Set();
  // 短原子：真实标题本身就是很有辨识度的片段，但长度常常 < 窗口，所以单独收一份
  const shortAtoms = new Map(); // 原子 -> 来源
  for (const e of doc.entries) {
    for (const field of [e.title, e.excerpt, e.markdown]) {
      for (const w of windowsOf(norm(field))) if (cjkCount(w) >= MIN_CJK) prints.add(w);
    }
    const t = norm(e.title);
    if (t.length >= 3 && t.length <= 20 && cjkCount(t) >= 3 && !baseline.has(t)) shortAtoms.set(t, `title:${e.id}`);
  }
  say(`真实数据：${doc.entries.length} 篇 → 散文型指纹 ${prints.size} 个（窗口 ${WINDOW} 字／含 ≥${MIN_CJK} 个中日韩字符）`
    + `｜短原子 ${shortAtoms.size} 个（真实标题，补 <${WINDOW} 字的盲区）`);

  const files = gitFiles();
  if (!files.length) { say('跳过：拿不到 git 文件列表（不是 git 仓库？）'); return 0; }
  say(`待扫描文件：${files.length} 个（git ls-files -co --exclude-standard）`);

  const hits = [];
  for (const f of files) {
    const abs = path.join(REPO, f);
    if (!existsSync(abs)) continue;
    let buf;
    try { buf = readFileSync(abs); } catch { continue; }
    if (buf.includes(0) || buf.length > 8_000_000) continue; // 二进制/超大文件跳过
    const text = buf.toString('utf8');
    const t = norm(text);
    for (let i = 0; i + WINDOW <= t.length; i++) {
      const w = t.slice(i, i + WINDOW);
      if (!prints.has(w) || baseline.has(w)) continue;
      const lines = text.split('\n');
      let at = null;
      for (let n = 0; n < lines.length; n++) if (norm(lines[n]).includes(w)) { at = n + 1; break; }
      hits.push({ file: f, atom: w, line: at, lineText: at ? lines[at - 1].trim().slice(0, 100) : '' });
    }
  }

  if (!hits.length) {
    say('');
    say('✓ 干净：未发现任何真实日记原文片段');
    return 0;
  }

  const byFile = new Map();
  for (const h of hits) {
    if (!byFile.has(h.file)) byFile.set(h.file, new Map());
    const m = byFile.get(h.file);
    if (!m.has(h.atom)) m.set(h.atom, h);
  }
  console.log('');
  console.log(`✗ 发现 ${byFile.size} 个文件含真实日记原文片段（明文被带进仓库了）：`);
  for (const [f, m] of byFile) {
    console.log(`  ${f}`);
    for (const [, h] of m) {
      // 默认脱敏：公开仓库的 CI 日志是公开的，别在这里再漏一遍
      const shown = SHOW ? `「${h.atom}」` : `[已脱敏 ${h.atom.length} 字]`;
      console.log(`    第 ${h.line} 行 命中 ${shown}${SHOW ? `  整行: ${h.lineText}` : ''}`);
    }
  }
  console.log('');
  console.log('修法：把示例/引文换成占位串（例如「某句只有你自己知道的日记原文」），不要拿真实原文当示例。');
  console.log('本机想看原文用 --show；CI 日志是公开的，不要 --show。');
  return 1;
}

process.exitCode = main();
