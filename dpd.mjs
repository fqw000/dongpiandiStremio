/**
 * 懂片帝接口探针
 *
 * 用途：
 *   - 验证 5 个 /v1/* 接口的连通性与签名
 *   - 提取每个接口返回的完整字段结构
 *   - 保存原始样本到 samples/ 便于后续参考
 *   - 运行后分析log.txt，快速定位接口情况
 *
 * 运行：
 *   node probe.mjs >log.txt 2>&1
 *
 * 输出：
 *   - 终端：结构摘要 + 通过/失败统计
 *   - samples/*.json：原始响应样本
 *
 * 
 *
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

//补充探针
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';


// ==========================================
// 配置
// ==========================================

const KEY = '8b9a908a05eac640e1ee06f52acaa741bfe4ba9e004eeffdbeb635e532e06666';
const BASE = 'https://dongpian20.com';
const SAMPLES_DIR = resolve(process.cwd(), 'samples');
const DELAY_MS = 200;   // 每次请求间隔，避免触发站点风控

const CLIENT_HEADERS = {
  'x-ai-movie-client-name': 'movie-search-frontend',
  'x-ai-movie-client-version': '1.0.0',
  'x-ai-movie-build-version': 'dongpiandi-v2026.09.30.1-dbb1f9857565-web',
  'x-ai-movie-protocol-version': '2026-07-05.library-v2.playback-v1',
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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
  const sig = [...new Uint8Array(sigBuf)]
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return {
    ...CLIENT_HEADERS,
    'x-ai-movie-timestamp': ts,
    'x-ai-movie-nonce': n,
    'x-ai-movie-signature': sig,
  };
}

// ==========================================
// HTTP
// ==========================================

async function call(method, path, body) {
  const headers = {
    'User-Agent': UA,
    'Referer': BASE + '/',
    'Accept': 'application/json',
    ...(await signHeaders(method, path)),
  };
  const opts = { method, headers };
  if (body) {
    opts.body = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }

  const start = Date.now();
  try {
    const res = await fetch(BASE + path, opts);
    const elapsed = Date.now() - start;
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, elapsed, json, raw: text };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      elapsed: Date.now() - start,
      json: null,
      raw: '',
      error: err.message,
    };
  }
}

// ==========================================
// 结构分析
// ==========================================

/**
 * 递归提取 JSON 的字段路径和类型
 * 例：{ cards: [{ title: 'x' }] } →
 *   cards[] : array(1)
 *   cards[].title : string
 */
function describe(obj, prefix = '', out = new Set(), depth = 0) {
  if (depth > 4) return out;
  if (Array.isArray(obj)) {
    out.add(`${prefix}[] : array(${obj.length})`);
    if (obj.length > 0) describe(obj[0], `${prefix}[]`, out, depth + 1);
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (Array.isArray(v)) {
        out.add(`${p}[] : array(${v.length})`);
        if (v.length > 0) describe(v[0], `${p}[]`, out, depth + 1);
      } else if (v && typeof v === 'object') {
        out.add(`${p} : object`);
        describe(v, p, out, depth + 1);
      } else {
        out.add(`${p} : ${v === null ? 'null' : typeof v}`);
      }
    }
  }
  return out;
}

// ==========================================
// 测试运行器
// ==========================================

const stats = { total: 0, passed: 0, failed: 0 };
const detailIds = {};   // 缓存从 catalog 提取的 id

function saveSample(name, data) {
  if (!existsSync(SAMPLES_DIR)) mkdirSync(SAMPLES_DIR, { recursive: true });
  const file = resolve(SAMPLES_DIR, `${name}.json`);
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
  return file;
}

async function test(name, path, validator, save = true) {
  stats.total++;
  process.stdout.write(`\n▶ ${name}\n  ${path}\n`);

  const res = await call('GET', path);

  if (!res.ok) {
    stats.failed++;
    console.log(`  ❌ HTTP ${res.status} (${res.elapsed}ms)${res.error ? ' — ' + res.error : ''}`);
    if (res.raw) console.log(`  raw: ${res.raw.slice(0, 200)}`);
    return null;
  }

  const info = validator(res.json);
  if (!info.valid) {
    stats.failed++;
    console.log(`  ❌ 校验失败: ${info.reason} (${res.elapsed}ms)`);
    return res.json;
  }

  stats.passed++;
  console.log(`  ✅ ${info.summary} (${res.elapsed}ms)`);

  const struct = [...describe(res.json)].sort();
  console.log(`  结构 (${struct.length} 个字段):`);
  for (const s of struct) console.log(`    ${s}`);

  if (save) {
    const file = saveSample(name, res.json);
    console.log(`  💾 ${file.replace(process.cwd() + '/', '')}`);
  }

  await new Promise(r => setTimeout(r, DELAY_MS));
  return res.json;
}

// ==========================================
// 主流程
// ==========================================

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  懂片帝接口探针');
  console.log('═══════════════════════════════════════════════════');

  // ===== 1. Catalog：6 个 kind =====
  console.log('\n【1】Catalog 基础（6 个 kind）');
  const kinds = ['movie', 'series', 'short_drama', 'anime', 'variety', 'documentary'];
  for (const kind of kinds) {
    const data = await test(
      `catalog-${kind}`,
      `/v1/browse/catalog?kind=${kind}&page=1&limit=20`,
      (d) => {
        if (!d || !Array.isArray(d.cards)) return { valid: false, reason: 'cards 非数组' };
        if (d.cards.length === 0) return { valid: false, reason: 'cards 为空' };
        const first = d.cards[0];
        if (!first.title || !first.detail_url) return { valid: false, reason: '首条缺 title/detail_url' };
        // 缓存一个 detail_url 供后续用
        if (!detailIds[kind]) detailIds[kind] = first.detail_url;
        return { valid: true, summary: `${d.cards.length} 条，首条：${first.title}` };
      }
    );
    // 缓存 pagination
    if (data && data.pagination) {
      console.log(`  📊 pagination: ${JSON.stringify(data.pagination)}`);
    }
  }

  // ===== 2. Catalog：筛选参数 =====
  console.log('\n【2】Catalog 筛选参数');
  await test('catalog-movie-genre', '/v1/browse/catalog?kind=movie&page=1&limit=20&genre=%E5%8A%A8%E4%BD%9C',
    (d) => Array.isArray(d?.cards) ? { valid: true, summary: `${d.cards.length} 条（动作）` } : { valid: false, reason: 'cards 非数组' });
  await test('catalog-movie-year', '/v1/browse/catalog?kind=movie&page=1&limit=20&year=2024',
    (d) => Array.isArray(d?.cards) ? { valid: true, summary: `${d.cards.length} 条（2024）` } : { valid: false, reason: 'cards 非数组' });
  await test('catalog-movie-trending', '/v1/browse/catalog?kind=movie&page=1&limit=20&sort=trending',
    (d) => Array.isArray(d?.cards) ? { valid: true, summary: `${d.cards.length} 条（trending）` } : { valid: false, reason: 'cards 非数组' });
  await test('catalog-movie-page2', '/v1/browse/catalog?kind=movie&page=2&limit=20',
    (d) => Array.isArray(d?.cards) ? { valid: true, summary: `${d.cards.length} 条（page 2）` } : { valid: false, reason: 'cards 非数组' });

  // ===== 3. Detail：6 个 kind 各 1 条 =====
  console.log('\n【3】Detail（6 个 kind）');
  for (const kind of kinds) {
    const rawUrl = detailIds[kind];
    if (!rawUrl) {
      console.log(`\n▶ detail-${kind}\n  ⏭️  无可用 id，跳过`);
      continue;
    }
    const vodId = rawUrl.startsWith('/v1/catalog/')
      ? rawUrl.slice('/v1/catalog/'.length) : rawUrl;
    await test(
      `detail-${kind}`,
      `/v1/catalog/${encodeURIComponent(vodId)}`,
      (d) => {
        if (!d || !d.title) return { valid: false, reason: '无 title' };
        return { valid: true, summary: `"${d.title}" (${d.year || '?'}) total_ep=${d.total_episode_count || 0}` };
      }
    );
  }

  // ===== 4. Episodes：电影 vs 剧集 =====
  console.log('\n【4】Episodes');
  const episodeTest = async (kind) => {
    const rawUrl = detailIds[kind];
    if (!rawUrl) return;
    const vodId = rawUrl.startsWith('/v1/catalog/')
      ? rawUrl.slice('/v1/catalog/'.length) : rawUrl;
    const data = await test(
      `episodes-${kind}`,
      `/v1/catalog/${encodeURIComponent(vodId)}/episodes`,
      (d) => {
        if (!d || !Array.isArray(d.episodes)) return { valid: false, reason: 'episodes 非数组' };
        return { valid: true, summary: `${d.episodes.length} 集` };
      }
    );
    if (data?.episode_pagination) {
      console.log(`  📊 episode_pagination: ${JSON.stringify(data.episode_pagination)}`);
    }
    return data;
  };
  const movieEps = await episodeTest('movie');
  const seriesEps = await episodeTest('series');
  await episodeTest('short_drama');

  // ===== 5. Resolve：电影 token + 剧集 token =====
  console.log('\n【5】Resolve（播放线路）');
  const resolveTest = async (label, eps) => {
    if (!eps || !eps.episodes || eps.episodes.length === 0) {
      console.log(`\n▶ resolve-${label}\n  ⏭️  无 token`);
      return;
    }
    const tok = eps.episodes[0].token;
    if (!tok) {
      console.log(`\n▶ resolve-${label}\n  ⏭️  首集无 token`);
      return;
    }
    const data = await test(
      `resolve-${label}`,
      `/v1/playback/resolve/${encodeURIComponent(tok)}?view=compact`,
      (d) => {
        if (!d || !Array.isArray(d.line_options)) return { valid: false, reason: 'line_options 非数组' };
        const total = d.line_options.length;
        const playable = d.line_options.filter(l => l.resolved && !l.resolve_required
          && ['m3u8', 'mp4'].includes(l.url_kind)).length;
        return { valid: true, summary: `${total} 条线路，其中 ${playable} 条可直连` };
      }
    );
    // 打印每条线路的关键字段
    if (data?.line_options) {
      console.log(`  线路明细:`);
      for (const l of data.line_options) {
        console.log(`    - play_from=${l.play_from} label=${l.label} url_kind=${l.url_kind} resolved=${l.resolved} req=${l.resolve_required}`);
      }
    }
  };
  await resolveTest('movie', movieEps);
  await resolveTest('series', seriesEps);

  // ===== 6. Suggest：中文 / 英文 / 无结果 =====
  console.log('\n【6】Suggest');
  await test('suggest-cn', `/v1/suggest?q=${encodeURIComponent('流浪地球')}&limit=20`,
    (d) => Array.isArray(d?.suggestions) ? { valid: true, summary: `${d.suggestions.length} 条建议` } : { valid: false, reason: 'suggestions 非数组' });
  await test('suggest-en', `/v1/suggest?q=${encodeURIComponent('Interstellar')}&limit=20`,
    (d) => Array.isArray(d?.suggestions) ? { valid: true, summary: `${d.suggestions.length} 条建议` } : { valid: false, reason: 'suggestions 非数组' });
  await test('suggest-none', `/v1/suggest?q=${encodeURIComponent('zzzznotexist999')}&limit=20`,
    (d) => Array.isArray(d?.suggestions) ? { valid: true, summary: `${d.suggestions.length} 条（预期 0）` } : { valid: false, reason: 'suggestions 非数组' });

  // ===== 汇总 =====
  console.log('\n═══════════════════════════════════════════════════');
  console.log(`  总计 ${stats.total} | ✅ ${stats.passed} | ❌ ${stats.failed}`);
  console.log('═══════════════════════════════════════════════════');
  console.log(`\n样本已保存到: ${SAMPLES_DIR}`);
  console.log('建议: samples/ 目录加入 .gitignore，或提交作为接口快照');
  process.exit(stats.failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('探针异常:', err);
  process.exit(1);
});



// 补充探针
const KEY = '8b9a908a05eac640e1ee06f52acaa741bfe4ba9e004eeffdbeb635e532e06666';
const BASE = 'https://dongpian20.com';
const SAMPLES = resolve(process.cwd(), 'samples');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let keyPromise = null;
function getKey() {
  if (!keyPromise) keyPromise = crypto.subtle.importKey('raw',
    new TextEncoder().encode(KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
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
    'x-ai-movie-build-version': 'dongpiandi-v2026.09.30.1-dbb1f9857565-web',
    'x-ai-movie-protocol-version': '2026-07-05.library-v2.playback-v1',
    'x-ai-movie-timestamp': ts,
    'x-ai-movie-nonce': n,
    'x-ai-movie-signature': sig,
  };
}

async function call(method, path, body) {
  const headers = {
    'User-Agent': UA,
    'Referer': BASE + '/',
    'Accept': 'application/json',
    ...(await signHeaders(method, path)),
  };
  const opts = { method, headers };
  if (body) {
    opts.body = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  const start = Date.now();
  try {
    const res = await fetch(BASE + path, opts);
    const elapsed = Date.now() - start;
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, elapsed, json, raw: text };
  } catch (err) {
    return { ok: false, status: 0, elapsed: Date.now() - start, json: null, raw: '', error: err.message };
  }
}

function save(name, data) {
  if (!existsSync(SAMPLES)) mkdirSync(SAMPLES, { recursive: true });
  writeFileSync(resolve(SAMPLES, name), JSON.stringify(data, null, 2), 'utf-8');
}

async function main() {
  const shortId = 'av_ZEtznDSf2kVNym0Earl9YhQuHjxNS8ek7NKCjsDsJZHDLeu1lGPqeQYGYhkeJL7T0l-3eeQeEclXxfs';

  console.log('═══════════════════════════════════════════════════');
  console.log('  补充探针');
  console.log('═══════════════════════════════════════════════════');

  // ===== A. episodes offset/limit =====
  console.log('\n【A】短剧 episodes 分页');
  const a1 = await call('GET', `/v1/catalog/${shortId}/episodes`);
  console.log(`  无参数: ${a1.json?.episodes?.length} 集, pagination=${JSON.stringify(a1.json?.episode_pagination)}`);
  save('episodes-short-p1.json', a1.json);

  const a2 = await call('GET', `/v1/catalog/${shortId}/episodes?offset=48&limit=48`);
  console.log(`  offset=48: ${a2.json?.episodes?.length} 集, pagination=${JSON.stringify(a2.json?.episode_pagination)}`);
  console.log(`  第 1 集 title=${a2.json?.episodes?.[0]?.title}`);
  save('episodes-short-p2.json', a2.json);

  // ===== B. resolve-line 匿名 =====
  console.log('\n【B】resolve-line 匿名 POST');
  // 先取一条 resolve_ticket 线路
  const resolveData = JSON.parse(
    await (await import('node:fs/promises')).readFile(resolve(SAMPLES, 'resolve-movie.json'), 'utf-8')
  );
  const ticketLine = resolveData.line_options.find(l => l.url_kind === 'resolve_ticket');
  if (!ticketLine) {
    console.log('  ❌ 无 resolve_ticket 线路');
  } else {
    console.log(`  样本 line: play_from=${ticketLine.play_from} label=${ticketLine.label}`);
    console.log(`  url 值: ${ticketLine.url}`);
    console.log(`  id 值: ${ticketLine.id}`);

    // 尝试用 url 里的 ticket 调 resolve-line
    const ticket = ticketLine.url.replace(/^resolve:\/\//, '');
    const b1 = await call('POST', '/v1/playback/resolve-line?view=compact', { ticket });
    console.log(`  POST /v1/playback/resolve-line body={ticket} → HTTP ${b1.status} (${b1.elapsed}ms)`);
    console.log(`  响应前 300 字符: ${b1.raw.slice(0, 300)}`);
    save('resolve-line-response.json', { status: b1.status, body: b1.json || b1.raw });

    // 试一下用 id 而不是 url 里的 ticket
    const b2 = await call('POST', '/v1/playback/resolve-line?view=compact', { ticket: ticketLine.id });
    console.log(`  POST body={ticket:id} → HTTP ${b2.status} (${b2.elapsed}ms)`);
    console.log(`  响应前 300 字符: ${b2.raw.slice(0, 300)}`);
  }

  // ===== C. Resolve 里可用线路的顺序字段 =====
  console.log('\n【C】Resolve 线路排序字段');
  const playable = resolveData.line_options.filter(l => l.resolved && !l.resolve_required);
  for (const l of playable.slice(0, 5)) {
    console.log(`  ${l.play_from} | default_priority=${l.default_priority} selected=${l.selected} weight=${l.preference_weight} provider=${l.provider_name || '-'}`);
  }
  const defaults = resolveData.line_options.filter(l => l.default_priority);
  console.log(`  带 default_priority 标记的线路: ${defaults.length} 条`);
  const selecteds = resolveData.line_options.filter(l => l.selected);
  console.log(`  带 selected 标记的线路: ${selecteds.length} 条`);

  // ===== 汇总 =====
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  补充探针完成，新样本已保存到 samples/');
  console.log('═══════════════════════════════════════════════════');
}

main().catch(err => { console.error(err); process.exit(1); });