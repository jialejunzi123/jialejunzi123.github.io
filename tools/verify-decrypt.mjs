#!/usr/bin/env node
/**
 * verify-decrypt.mjs — 独立解密校验（不引用 sync-diary.mjs 的任何加密函数）
 *
 * 故意改用 WebCrypto（crypto.subtle）而不是生成器用的 node:crypto createDecipheriv，
 * 这样等于把「浏览器 A 端」的解密路径也一起验证了：参数对不上这里就会失败。
 *
 * 用法：
 *   node tools/verify-decrypt.mjs --password <pw>                          # 校验 diaries.enc.json
 *   node tools/verify-decrypt.mjs --password <pw> --out /tmp/plain.json    # 顺便导出明文，便于逐字节比对
 *   node tools/verify-decrypt.mjs --password <pw> --media diary/media/x.jpg.enc --out /tmp/x.jpg
 *
 * 密码来源优先级：--password > 环境变量 DIARY_PASSWORD > tools/config.json 的 password
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const o = { in: path.join(REPO_ROOT, 'diary', 'data', 'diaries.enc.json'), media: null, out: null, password: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--in') o.in = path.resolve(next());
    else if (a === '--media') o.media = path.resolve(next());
    else if (a === '--out') o.out = path.resolve(next());
    else if (a === '--password' || a === '-p') o.password = next();
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  return o;
}

function resolvePassword(cliPw) {
  if (cliPw) return cliPw;
  if (process.env.DIARY_PASSWORD) return process.env.DIARY_PASSWORD.trim();
  const cfgFile = path.join(__dirname, 'config.json');
  if (existsSync(cfgFile)) {
    try {
      const pw = JSON.parse(readFileSync(cfgFile, 'utf8')).password;
      if (pw) return String(pw).trim();
    } catch { /* ignore */ }
  }
  throw new Error('没有密码：用 --password、环境变量 DIARY_PASSWORD，或 tools/config.json 的 password');
}

/** 用 WebCrypto 按契约派生主密钥：PBKDF2-SHA256，iterations，256bit */
async function deriveKeyWebCrypto(password, salt, iterations) {
  const enc = new TextEncoder();
  const km = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, km, 256);
  return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['decrypt']);
}

/** 解 iv(12B) || ciphertext || tag(16B)：WebCrypto 需要的 ciphertext 是「密文+tag」 */
async function decryptPacked(key, packed, label) {
  if (packed.length < 12 + 16) throw new Error(`${label}：长度不足（${packed.length}B），至少要有 12B iv + 16B tag`);
  const iv = packed.subarray(0, 12);
  const body = packed.subarray(12); // 密文 + tag（WebCrypto 直接吃这个）
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, body);
  return Buffer.from(plain);
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log('用法：node tools/verify-decrypt.mjs [--password pw] [--in x.enc.json | --media x.enc] [--out plain]'); return; }
  const password = resolvePassword(args.password);

  if (args.media) {
    // ── 图片/媒体密文：单文件，iv(12B) || AES-256-GCM 密文+tag，salt/iterations 取自 diaries.enc.json ──
    const env = JSON.parse(readFileSync(args.in, 'utf8'));
    const key = await deriveKeyWebCrypto(password, Buffer.from(env.salt, 'base64'), env.iterations);
    const plain = await decryptPacked(key, readFileSync(args.media), path.basename(args.media));
    console.log(`✓ 媒体解密成功：${path.relative(REPO_ROOT, args.media)}`);
    console.log(`  明文字节：${plain.length} B｜sha256：${sha256(plain)}`);
    console.log(`  iv(前12B, hex)：${readFileSync(args.media).subarray(0, 12).toString('hex')}`);
    const buf = readFileSync(args.media);
    console.log(`  GCM tag(末16B, hex)：${buf.subarray(buf.length - 16).toString('hex')}`);
    if (args.out) { writeFileSync(args.out, plain); console.log(`  明文已写出：${args.out}`); }
    return;
  }

  // ── diaries.enc.json 信封 ──
  const env = JSON.parse(readFileSync(args.in, 'utf8'));
  if (env.enc !== 'AES-256-GCM' || env.kdf !== 'PBKDF2-SHA256') {
    throw new Error(`信封算法不符契约：enc=${env.enc} kdf=${env.kdf}`);
  }
  if (Number(env.iterations) !== 200000) throw new Error(`迭代次数不符契约：${env.iterations}`);
  const salt = Buffer.from(env.salt, 'base64');
  const iv = Buffer.from(env.iv, 'base64');
  if (salt.length !== 16) throw new Error(`salt 应为 16B，实际 ${salt.length}B`);
  if (iv.length !== 12) throw new Error(`iv 应为 12B，实际 ${iv.length}B`);

  const key = await deriveKeyWebCrypto(password, salt, Number(env.iterations));
  let plain;
  try {
    plain = await decryptPacked(key, Buffer.concat([iv, Buffer.from(env.ciphertext, 'base64')]), 'diaries.enc.json');
  } catch (e) {
    throw new Error(`解密失败（密码错误或密文损坏）：${e.message}`);
  }

  const doc = JSON.parse(plain.toString('utf8'));
  console.log('✓ diaries.enc.json 解密成功');
  console.log(`  迭代 ${env.iterations}｜salt ${salt.length}B｜iv ${iv.length}B｜密文 ${Buffer.from(env.ciphertext, 'base64').length} B`);
  console.log(`  明文字节：${plain.length} B｜sha256：${sha256(plain)}`);
  console.log(`  schema=${doc.schema} count=${doc.count} encrypted=${doc.encrypted} source=${doc.source}`);
  console.log(`  hint.count=${env.hint?.count} generatedAt=${env.hint?.generatedAt}（与正文一致：${env.hint?.count === doc.count ? '是' : '否'}）`);
  console.log(`  tags=${JSON.stringify(doc.tags)}｜entries=${doc.entries.length}`);
  const first = doc.entries[0];
  console.log(`  首条：${first?.createTime}｜${first?.title || '(无标题)'}｜media ${first?.media?.length ?? 0} 个`);
  console.log(`  末条：${doc.entries[doc.entries.length - 1]?.createTime}`);
  // 独立复核：字段齐全 + 严格倒序（契约规则 1、6）
  const required = ['id', 'createTime', 'updateTime', 'date', 'year', 'month', 'time', 'title', 'excerpt', 'markdown', 'tags', 'mood', 'weather', 'location', 'top', 'words', 'media'];
  const missingFields = new Set();
  for (const e of doc.entries) for (const k of required) if (!(k in e)) missingFields.add(k);
  let ordered = true;
  for (let i = 1; i < doc.entries.length; i++) {
    if (doc.entries[i - 1].createTime < doc.entries[i].createTime) { ordered = false; break; }
  }
  console.log(`  字段缺失：${missingFields.size ? [...missingFields].join(', ') : '无'}`);
  console.log(`  按 createTime 严格倒序：${ordered ? '是' : '否'}`);
  console.log(`  count === entries.length：${doc.count === doc.entries.length ? '是' : '否'}`);
  // markdown 里不应再有 appdata 引用（media[].uri 按契约保留原始 appdata 路径，属正常）
  const mdResidual = doc.entries.reduce((s, e) => s + ((e.markdown ?? '').match(/appdata\//g) ?? []).length, 0);
  const uriKept = doc.entries.reduce((s, e) => s + e.media.filter((m) => String(m.uri).startsWith('appdata/')).length, 0);
  const encFiles = doc.entries.reduce((s, e) => s + e.media.filter((m) => String(m.file).endsWith('.enc')).length, 0);
  console.log(`  markdown 残留 appdata 引用：${mdResidual} 处（应为 0）`);
  console.log(`  media[] 保留原始 uri：${uriKept} 个｜指向 .enc 的：${encFiles} 个（密码模式应全部为 .enc）`);
  if (args.out) { writeFileSync(args.out, plain); console.log(`  明文已写出：${args.out}`); }
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exitCode = 1;
});
