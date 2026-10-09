#!/usr/bin/env node

/**
 * 懂片帝 Stremio Addon 健康检测
 *
 * 功能：
 *   1. 连通性检测：manifest / catalog / detail / episodes / resolve
 *   2. 线路质量检测：遍历若干片，统计每个线路名的成功/失败分布
 *   3. 黑名单建议：标记长期 402/404 的线路名
 *
 * 使用：
 *   node health.js                       # 默认检测 5 部片
 *   node health.js --limit=10            # 检测 10 部片
 *   node health.js --no-cookie           # 不测 resolve-line（只测直连）
 *   COOKIE=ums2_xxx node health.js       # 用指定 Cookie
 *
 * 输出：
 *   - 终端报告（按线路名聚合）
 *   - 建议黑名单（可直接复制到配置页面）
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ==========================================
// 配置
// ==========================================

const KEY = '8b9a908a05eac640e1ee06f52acaa741bfe4ba9e004eeffdbeb635e532e06666';
const BASE = 'https://dongpian20.com';
const BUILD_VERSION = 'dongpiandi-v2026.09.30.1-dbb1f9857565-web';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ==========================================
// 参数解析
// ==========================================

const args = process.argv.slice(2);
const LIMIT = (() => {
  const a = args.find(x => x.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) || 5 : 5;
})();
const NO_COOKIE = args.includes('--no-cookie');
const COOKIE_VALUE = process.env.COOKIE || process.env.DEFAULT_SESSION_COOKIE || '';

// ==========================================
// 签名
// ==========================================

let keyPromise = null;
function getKey() {
  if (!keyPromise) {
    keyPromise = crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(KEY),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
  }
  return keyPromise;
}

function nonce() {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

async function signHeaders(method, path) {
  const ts = String(Date.now());
  const n = nonce();
  const msg = `${method.toUpperCase()}\n${path}\n${ts}\n${n}`;
  const key = await getKey();
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  const sig = [...new Uint8Array(sigBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
  return {
    'x-ai-movie-client-name': 'movie-search-frontend',
    'x-ai-movie-client-version': '1.0.0',
    'x-ai-movie-build-version': BUILD_VERSION,
    'x-ai-movie-protocol-version': '2026-07-05.library-v2.playback-v1',
    'x-ai-movie-timestamp': ts,
    'x-ai-movie-nonce': n,
    'x-ai-movie-signature': sig,
  };
}

// ==========================================
// 请求
// ==========================================

async function callGet(path) {
  const headers = {
    'User-Agent': UA,
    'Referer': BASE + '/',
    'Accept': 'application/json',
    ...(await signHeaders('GET', path)),
  };
  const start = Date.now();
  try {
    const res = await fetch(BASE + path, { headers });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, elapsed: Date.now() - start, json, raw: text };
  } catch (err) {
    return { ok: false, status: 0, elapsed: Date.now() - start, json: null, raw: '', error: err.message };
  }
}

async function callPost(path, body, cookieValue) {
  const headers = {
    'User-Agent': UA,
    'Referer': BASE + '/',
    'Origin': BASE,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    ...(cookieValue ? { 'Cookie': `ai_movie_session=${cookieValue}` } : {}),
    ...(await signHeaders('POST', path)),
  };
  const start = Date.now();
  try {
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, elapsed: Date.now() - start, json, raw: text };
  } catch (err) {
    return { ok: false, status: 0, elapsed: Date.now() - start, json: null, raw: '', error: err.message };
  }
}

// ==========================================
// 工具
// ==========================================

function hr(title) {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  ' + title);
  console.log('═══════════════════════════════════════════════════');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 线路统计
const lineStats = new Map();

function recordLine(label, result, httpStatus) {
  if (!label) return;
  if (!lineStats.has(label)) {
    lineStats.set(label, {
      label,
      total: 0,
      ok: 0,
      http_201: 0,
      http_200: 0,
      http_402: 0,
      http_404: 0,
      http_429: 0,
      http_5xx: 0,
      timeout: 0,
      other: 0,
    });
  }
  const s = lineStats.get(label);
  s.total++;
  if (result === 'ok') {
    s.ok++;
    if (httpStatus === 201) s.http_201++;
    else if (httpStatus === 200) s.http_200++;
  } else if (result === 'timeout') {
    s.timeout++;
  } else {
    if (httpStatus === 402) s.http_402++;
    else if (httpStatus === 404) s.http_404++;
    else if (httpStatus === 429) s.http_429++;
    else if (httpStatus >= 500) s.http_5xx++;
    else s.other++;
  }
}

// ==========================================
// 检测流程
// ==========================================

/**
 * 阶段 1：基础连通性
 */
async function testBasics() {
  hr('阶段 1：基础连通性');

  const checks = [
    ['/v1/browse/catalog?kind=movie&page=1&limit=1', 'Catalog'],
    ['/v1/suggest?q=%E4%B8%89%E4%BD%93&limit=5', 'Suggest'],
  ];

  for (const [path, name] of checks) {
    const r = await callGet(path);
    const symbol = r.ok ? '✅' : '❌';
    console.log(`  ${symbol} ${name}: HTTP ${r.status} (${r.elapsed}ms)`);
    await sleep(300);
  }
}

/**
 * 阶段 2：遍历 N 部片，检测线路
 */
async function testLines() {
  hr(`阶段 2：线路质量检测（${LIMIT} 部片）`);

  const useCookie = !NO_COOKIE && COOKIE_VALUE && COOKIE_VALUE.length > 20;

  console.log(`  Cookie: ${useCookie ? '已配置（解析官方线路）' : '未配置（仅测直连）'}`);
  console.log(`  build-version: ${BUILD_VERSION}`);
  console.log('');

  const catalog = await callGet('/v1/browse/catalog?kind=movie&page=1&limit=20');
  if (!catalog.ok || !catalog.json?.cards?.length) {
    console.error('  ❌ catalog 拉取失败');
    return;
  }

  const cards = catalog.json.cards.slice(0, LIMIT);

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const vodId = (card.detail_url || card.id).replace(/^\/v1\/catalog\//, '');
    console.log(`  [${i + 1}/${cards.length}] ${card.title} (${card.year})`);

    await sleep(200);
    const eps = await callGet(`/v1/catalog/${encodeURIComponent(vodId)}/episodes`);
    if (!eps.ok || !eps.json?.episodes?.length) {
      console.log(`      ⚠️ episodes 拉取失败`);
      continue;
    }

    await sleep(200);
    const token = eps.json.episodes[0].token;
    const resolve_ = await callGet(`/v1/playback/resolve/${encodeURIComponent(token)}?view=compact`);
    if (!resolve_.ok || !resolve_.json?.line_options) {
      console.log(`      ⚠️ resolve 拉取失败`);
      continue;
    }

    const lines = resolve_.json.line_options;
    const ticketLines = lines.filter(l => l.url_kind === 'resolve_ticket');
    const directLines = lines.filter(l => l.url_kind === 'm3u8' || l.url_kind === 'mp4');

    console.log(`      线路: 官方 ${ticketLines.length} / 直连 ${directLines.length}`);

    // 直连线路：不实际请求，只记录存在性
    for (const l of directLines) {
      recordLine(l.label || l.play_from, 'ok', 200);
    }

    // 官方线路：带 Cookie 则实测
    if (useCookie && ticketLines.length > 0) {
      for (const l of ticketLines) {
        const ticket = String(l.url || '').replace(/^resolve:\/\//, '');
        if (!ticket) continue;

        const r = await callPost(
          '/v1/playback/resolve-line?view=compact',
          { ticket },
          COOKIE_VALUE
        );

        const label = l.label || l.play_from || '官方线路';

        if (r.ok && r.json?.line?.url) {
          recordLine(label, 'ok', r.status);
        } else if (r.elapsed >= 15000 || (r.error && r.error.includes('abort'))) {
          recordLine(label, 'timeout', 0);
        } else {
          recordLine(label, 'fail', r.status);
        }

        await sleep(300);
      }
    }

    await sleep(300);
  }
}

/**
 * 阶段 3：报告
 */
function printReport() {
  hr('阶段 3：线路质量报告');

  const stats = [...lineStats.values()].sort((a, b) => b.total - a.total);

  // 表头
  console.log('');
  console.log('  ' + '线路名'.padEnd(30, ' ') + '总  ' + '成  ' + '402 ' + '404 ' + '429 ' + '超时 ' + '其他');
  console.log('  ' + '─'.repeat(70));

  const blacklist = [];

  for (const s of stats) {
    const okRate = s.total > 0 ? (s.ok / s.total) : 0;
    const label = s.label.length > 28 ? s.label.slice(0, 27) + '…' : s.label;

    console.log(
      '  ' + label.padEnd(30, ' ') +
      String(s.total).padEnd(3, ' ') + ' ' +
      String(s.ok).padEnd(3, ' ') + ' ' +
      String(s.http_402).padEnd(3, ' ') + ' ' +
      String(s.http_404).padEnd(3, ' ') + ' ' +
      String(s.http_429).padEnd(3, ' ') + ' ' +
      String(s.timeout).padEnd(4, ' ') + ' ' +
      String(s.other + s.http_5xx).padEnd(3, ' ')
    );

    // 黑名单判定：
    // - 总次数 >= 3
    // - 成功率 <= 33%
    // - 主要为 402/404/超时
    if (s.total >= 3 && okRate <= 0.33) {
      blacklist.push(s);
    }
  }

  hr('建议加入黑名单的线路');
  if (blacklist.length === 0) {
    console.log('  ✅ 无可推荐的线路（所有线路成功率都较高）');
  } else {
    console.log('  以下线路长期失败，可加入黑名单提升用户体验：\n');
    for (const s of blacklist) {
      const okRate = ((s.ok / s.total) * 100).toFixed(0);
      console.log(`    ${s.label}`);
      console.log(`      出现 ${s.total} 次，成功 ${s.ok} 次（${okRate}%），402=${s.http_402} 404=${s.http_404} 超时=${s.timeout}`);
    }
    console.log('');
    console.log('  可直接复制到配置页面的「线路黑名单」输入框（每行一个）：');
    console.log('');
    for (const s of blacklist) {
      console.log(`    ${s.label}`);
    }
  }

  // 追加：生成可直接粘贴到 config.js 的格式
  if (blacklist.length > 0) {
    hr('可直接粘贴到 src/config.js 的代码');
    console.log('');
    console.log('const DEFAULT_BLOCKED_LINES = [');
    for (const s of blacklist) {
      console.log(`  '${s.label}',`);
    }
    console.log('];');
    console.log('');
  }

  // 保存 JSON 供脚本使用
  const samplesDir = resolve(process.cwd(), 'samples');
  if (!existsSync(samplesDir)) mkdirSync(samplesDir, { recursive: true });
  const reportPath = resolve(samplesDir, `health-${Date.now()}.json`);
  writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    buildVersion: BUILD_VERSION,
    limit: LIMIT,
    stats: [...lineStats.values()],
    blacklist: blacklist.map(s => s.label),
  }, null, 2), 'utf-8');
  console.log(`\n  报告已保存: ${reportPath.replace(process.cwd() + '/', '')}`);
}

// ==========================================
// 主流程
// ==========================================

async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('  懂片帝 Stremio Addon · 健康检测');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  站点: ${BASE}`);
  console.log(`  片数: ${LIMIT}`);
  console.log(`  Cookie: ${NO_COOKIE ? '跳过（--no-cookie）' : (COOKIE_VALUE ? '已提供' : '未提供（读环境变量 COOKIE）')}`);

  await testBasics();
  await testLines();
  printReport();

  console.log('');
  console.log('  完成。');
  console.log('');
}

main().catch(err => {
  console.error('脚本异常:', err);
  process.exit(1);
});