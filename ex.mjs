/**
 * 补充探针：验证分页参数 + resolve-line 匿名调用
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

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