/**
 * HMAC-SHA256 请求签名（Edge Runtime WebCrypto）
 *
 * 算法（与懂片帝 movie-card-runtime-*.js 一致）：
 *   sign = HMAC-SHA256(key, "METHOD\n/path?query\n毫秒时间戳\n32位hex随机数")
 *   输出 hex 小写
 * 
 */

import { CONFIG } from './config.js';

// 从 CONFIG 动态读取 build-version，避免硬编码
// 注意：这个函数每次调用都会读 CONFIG，但 CONFIG 是 Proxy，
// 值会被缓存，所以性能无影响
const CLIENT_HEADERS = {
  'x-ai-movie-client-name': 'movie-search-frontend',
  'x-ai-movie-client-version': '1.0.0',
  'x-ai-movie-build-version': 'dongpiandi-v2026.09.30.1-dbb1f9857565-web',
  // 'x-ai-movie-build-version': 'dongpiandi-v2026.10.08.6-source-lifetime-c61ad1f06e2a-web',
  // 'x-ai-movie-build-version': CONFIG.BUILD_VERSION,
  'x-ai-movie-protocol-version': '2026-07-05.library-v2.playback-v1',
};

let _keyPromise = null;

function getKey() {
  if (!_keyPromise) {
    _keyPromise = crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(CONFIG.API_KEY),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
  }
  return _keyPromise;
}

function generateNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function toHex(buf) {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

export async function buildSignHeaders(method, pathWithQuery) {
  const ts = String(Date.now());
  const nonce = generateNonce();
  const msg = `${method.toUpperCase()}\n${pathWithQuery}\n${ts}\n${nonce}`;
  const key = await getKey();
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  const sig = toHex(sigBuf);

  return {
    ...CLIENT_HEADERS,
    'x-ai-movie-timestamp': ts,
    'x-ai-movie-nonce': nonce,
    'x-ai-movie-signature': sig,
  };
}