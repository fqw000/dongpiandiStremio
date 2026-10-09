const KEY = '8b9a908a05eac640e1ee06f52acaa741bfe4ba9e004eeffdbeb635e532e06666';
const BASE = 'https://dongpian20.com';

async function signHeaders(method, path) {
  const ts = String(Date.now());
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const msg = `${method.toUpperCase()}\n${path}\n${ts}\n${nonce}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(KEY),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  const sig = [...new Uint8Array(sigBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
  return {
    'x-ai-movie-client-name': 'movie-search-frontend',
    'x-ai-movie-client-version': '1.0.0',
    'x-ai-movie-build-version': 'dongpiandi-v2026.09.30.1-dbb1f9857565-web',
    'x-ai-movie-protocol-version': '2026-07-05.library-v2.playback-v1',
    'x-ai-movie-timestamp': ts,
    'x-ai-movie-nonce': nonce,
    'x-ai-movie-signature': sig,
  };
}

async function call(path) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Referer': BASE + '/',
    'Accept': 'application/json',
    ...(await signHeaders('GET', path)),
  };
  const res = await fetch(BASE + path, { headers });
  const text = await res.text();
  console.log(`\n=== ${path} ===`);
  console.log('Status:', res.status);
  console.log(text.slice(0, 1500));
  return { status: res.status, text };
}

// 测试 1：搜索"流浪地球"
const kw = encodeURIComponent('流浪地球');
await call(`/v1/suggest?q=${kw}&limit=20`);

// 测试 2：搜索"三体"
const kw2 = encodeURIComponent('三体');
await call(`/v1/suggest?q=${kw2}&limit=20`);