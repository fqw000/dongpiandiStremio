/**
 * HTTP 客户端
 *
 * 特性：
 *   - 自动为懂片帝请求加上 HMAC-SHA256 签名头
 *   - 每次重试重新生成签名（时间戳/nonce 必须变化）
 *   - 区分 AbortController 主动超时和 undici 底层连接失败
 *   - 403/401 不重试（签名错或站点拒绝，重试无意义）
 *
 * @module http
 */

import { CONFIG, DEFAULT_HEADERS } from './config.js';
import { buildSignHeaders } from './sign.js';
import { createLogger } from './logger.js';

const log = createLogger('HTTP');

const BASE = () => `https://${CONFIG.BASE_DOMAIN}`;

/**
 * 带超时的 fetch
 *
 * 注意：AbortController 只能中断到我们的 timeout；
 * Node 18 的 undici 自身还有约 10s 的连接超时，会先于 AbortController 抛出
 * "fetch failed" / "Connect Timeout Error"。所以两种错误都要区分记录。
 *
 * @param {string} url
 * @param {Object} options
 * @param {number} timeout
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const start = Date.now();

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    log.info(`${res.status} (${Date.now() - start}ms) ${url}`);
    return res;
  } catch (err) {
    clearTimeout(timer);
    const elapsed = Date.now() - start;

    if (err.name === 'AbortError') {
      log.error(`超时 (>${timeout}ms) ${url}`);
    } else if (err.message && err.message.includes('fetch failed')) {
      log.error(`连接失败 (${elapsed}ms) ${url} — ${err.message}`);
    } else {
      log.error(`${err.name}: ${err.message} (${elapsed}ms) ${url}`);
    }

    throw err;
  }
}

/**
 * 对懂片帝发起签名 GET，返回 JSON
 *
 * @param {string} pathWithQuery - 以 / 开头的路径 + 查询串
 * @returns {Promise<Object|null>}
 */
export async function apiGet(pathWithQuery) {
  const url = BASE() + pathWithQuery;
  const timeout = CONFIG.REQUEST_TIMEOUT;
  let lastErr;

  for (let attempt = 0; attempt <= CONFIG.RETRY_COUNT; attempt++) {
    try {
      // 每次重试都重新签名：时间戳 + nonce 必须变化，
      // 否则会命中服务端的重放检测而被拒
      const signHeaders = await buildSignHeaders('GET', pathWithQuery);

      const headers = {
        ...DEFAULT_HEADERS,
        'Referer': BASE() + '/',
        'Accept': 'application/json',
        ...signHeaders,
      };

      const res = await fetchWithTimeout(url, { headers, redirect: 'follow' }, timeout);

      if (!res.ok) {
        // 401/403 通常是签名错或站点拒绝，重试无意义
        if (res.status === 401 || res.status === 403) {
          throw new Error(`HTTP ${res.status} Forbidden`);
        }
        throw new Error(`HTTP ${res.status}`);
      }

      const text = await res.text();
      return JSON.parse(text);
    } catch (err) {
      lastErr = err;

      // 签名被拒 → 立即失败，不重试
      if (err.message && err.message.includes('Forbidden')) throw err;

      if (attempt < CONFIG.RETRY_COUNT) {
        log.warn(`${CONFIG.RETRY_DELAY}ms 后重试 (${attempt + 1}/${CONFIG.RETRY_COUNT})`);
        await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY));
      }
    }
  }

  throw lastErr;
}


/**
 * 对懂片帝发起签名 POST，返回 JSON
 *
 * 与 apiGet 的差异：
 *   - method 为 POST
 *   - 请求体为 JSON 字符串
 *   - 附加 Cookie 头（如果传了 cookie）
 *   - 201 也视为成功（resolve-line 返回 201）
 *
 * @param {string} pathWithQuery - 以 / 开头的路径 + 查询串
 * @param {Object} body - 请求体
 * @param {Object} options - { cookie: string } 可选
 * @returns {Promise<Object|null>}
 */
export async function apiPost(pathWithQuery, body, options = {}) {
  const url = BASE() + pathWithQuery;
  const timeout = CONFIG.REQUEST_TIMEOUT;
  const cookie = options.cookie || '';
  let lastErr;

  for (let attempt = 0; attempt <= CONFIG.RETRY_COUNT; attempt++) {
    try {
      const signHeaders = await buildSignHeaders('POST', pathWithQuery);

      const headers = {
        ...DEFAULT_HEADERS,
        'Referer': BASE() + '/',
        'Origin': BASE(),
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        ...signHeaders,
      };
      if (cookie) headers['Cookie'] = cookie;

      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        redirect: 'follow',
      }, timeout);

      // 201 Created 也视为成功
      if (!res.ok && res.status !== 201) {
        if (res.status === 401 || res.status === 403) {
          throw new Error(`HTTP ${res.status} Forbidden`);
        }
        throw new Error(`HTTP ${res.status}`);
      }

      const text = await res.text();
      return JSON.parse(text);
    } catch (err) {
      lastErr = err;

      // 4xx 业务错误不重试：签名错、无权限、付费墙、票据失效、限流
      // 只对网络错误和 5xx 重试
      if (err.message && /HTTP 4\d\d/.test(err.message)) throw err;

      if (attempt < CONFIG.RETRY_COUNT) {
        log.warn(`${CONFIG.RETRY_DELAY}ms 后重试 (${attempt + 1}/${CONFIG.RETRY_COUNT})`);
        await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY));
      }
    }
  }

  throw lastErr;
}

