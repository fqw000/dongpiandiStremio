/**
 * HTTP 客户端：自动签名 + 超时 + 重试
 * 每次重试重新生成签名（时间戳/nonce 变化）
 */

import { CONFIG, DEFAULT_HEADERS } from './config.js';
import { buildSignHeaders } from './sign.js';

const BASE = () => `https://${CONFIG.BASE_DOMAIN}`;

async function fetchWithTimeout(url, options, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const start = Date.now();
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    console.log(`[HTTP] ✅ ${res.status} (${Date.now() - start}ms) ${url}`);
    return res;
  } catch (err) {
    clearTimeout(timer);
    console.error(`[HTTP] ❌ ${err.name}: ${err.message} (${Date.now() - start}ms)`);
    throw err;
  }
}

export async function apiGet(pathWithQuery) {
  const url = BASE() + pathWithQuery;
  const timeout = CONFIG.REQUEST_TIMEOUT;
  let lastErr;

  for (let attempt = 0; attempt <= CONFIG.RETRY_COUNT; attempt++) {
    try {
      // 每次重试重新签名（时间戳/nonce 变化）
      const signHeaders = await buildSignHeaders('GET', pathWithQuery);
      const headers = {
        ...DEFAULT_HEADERS,
        'Referer': BASE() + '/',
        'Accept': 'application/json',
        ...signHeaders,
      };

      const res = await fetchWithTimeout(url, { headers, redirect: 'follow' }, timeout);

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new Error(`HTTP ${res.status} Forbidden`);
        }
        throw new Error(`HTTP ${res.status}`);
      }

      const text = await res.text();
      return JSON.parse(text);
    } catch (err) {
      lastErr = err;
      if (err.message.includes('Forbidden')) throw err;
      if (err.name === 'AbortError') throw new Error(`超时 (>${timeout}ms)`);
      if (attempt < CONFIG.RETRY_COUNT) {
        console.log(`[HTTP] ⏳ ${CONFIG.RETRY_DELAY}ms 后重试...`);
        await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY));
      }
    }
  }
  throw lastErr;
}