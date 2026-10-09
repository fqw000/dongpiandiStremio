/**
 * 全局配置
 * 用户配置通过 globalThis.__USER_CONFIG 注入（base64url cfg 参数）
 */

/**
 * 代码内维护的公共线路黑名单
 *
 * 添加原则：
 *   - 只加"跨片稳定失效"的线路（避免误伤偶尔抽风的优质线路）
 *   - 依据：运行 `node health.js --limit=10` 观察统计
 *   - 常见案例：第三方联动线路（腾讯/优酷/爱奇艺/芒果TV）长期 404
 *
 * 用户可通过配置页面追加，是"增量"而非"覆盖"——代码里的始终生效
 */
const DEFAULT_BLOCKED_LINES = [
  // 根据 health.js 报告手动维护。当前留空，观察几周后再补。
  // 示例：
  // '腾讯视频 · 普通话',
  // '芒果TV',
  '牛牛资源',
];

const ALL_CATEGORIES = ['movie', 'series', 'short', 'anime', 'variety', 'documentary'];

function getUserConfig() {
  return (typeof globalThis !== 'undefined' && globalThis.__USER_CONFIG) || {};
}

function buildConfig() {
  const user = getUserConfig();

  let enabledCategories;
  if (Array.isArray(user.cats)) {
    enabledCategories = user.cats.filter(c => ALL_CATEGORIES.includes(c));
    if (enabledCategories.length === 0) enabledCategories = ['movie'];
  } else {
    enabledCategories = ALL_CATEGORIES;
  }

  return {
    // ===== 部署环境标识 =====
    // 用于 Upstash Redis Key 前缀，支持多项目共用同一数据库
    // 通过环境变量 APP_PREFIX 覆盖，默认 dongpiandi:prod
    APP_PREFIX: process.env?.APP_PREFIX || 'dongpiandi:prod',
    LOG_LEVEL: process.env?.LOG_LEVEL || 'info',

    // ===== 用户登录 Cookie（可选）=====
    // 优先级：用户 cfg 配置 > 环境变量 DEFAULT_SESSION_COOKIE > 空
    // 配置后可解析 resolve:// 票据，返回官方高清 mp4 直链
    // 空字符串表示未配置，走 m3u8 匿名线路
    SESSION_COOKIE: (() => {
      if (typeof user.cookie === 'string' && user.cookie.trim()) {
        return user.cookie.trim();
      }
      const envCookie = typeof process !== 'undefined' && process.env?.DEFAULT_SESSION_COOKIE;
      if (envCookie) return String(envCookie).trim();
      return '';
    })(),

    BASE_DOMAIN: user.bd || 'dongpian17.com',
    USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    API_KEY: '8b9a908a05eac640e1ee06f52acaa741bfe4ba9e004eeffdbeb635e532e06666',
    TMDB_API_KEY: user.tk || 'e5c3c7269a147fee368c3649ddd98875',
    DEVICE_ID: getUUID(),
    ENABLE_IMDB: user.imdb !== false,
    ENABLE_STREAM: user.stream !== false,
    ENABLED_CATEGORIES: user.cats || ALL_CATEGORIES,
    REQUEST_TIMEOUT: 15000,
    RETRY_COUNT: 2,
    RETRY_DELAY: 500,
    PAGE_SIZE: 20,
    MATCH_THRESHOLD: 0.5,

    // ===== 懂片帝 build-version =====
    // 站点前端发版时会变，失效后从浏览器抓包重新获取
    // 覆盖方式：环境变量 BUILD_VERSION 或 cfg 参数中的 bv 字段
    BUILD_VERSION: (() => {
      if (typeof user.bv === 'string' && user.bv.trim()) return user.bv.trim();
      return 'dongpiandi-v2026.09.30.1-dbb1f9857565-web';
    })(),

        // ===== 线路黑名单（代码默认 + 用户增量）=====
    // 优先级：DEFAULT_BLOCKED_LINES ∪ user.blockedLines
    BLOCKED_LINES: (() => {
      const merged = new Set(DEFAULT_BLOCKED_LINES);
      if (Array.isArray(user.blockedLines)) {
        for (const s of user.blockedLines) {
          if (typeof s === 'string' && s.trim()) merged.add(s.trim());
        }
      }
      return [...merged];
    })(),

  };
}

let _cache = null;
let _cacheKey = '';

export function getConfig() {
  const key = JSON.stringify(getUserConfig());
  if (!_cache || key !== _cacheKey) {
    _cache = buildConfig();
    _cacheKey = key;
  }
  return _cache;
}

export const CONFIG = new Proxy({}, {
  get(_, prop) { return getConfig()[prop]; },
  has(_, prop) { return prop in getConfig(); },
  ownKeys() { return Reflect.ownKeys(getConfig()); },
  getOwnPropertyDescriptor(_, prop) {
    return { enumerable: true, configurable: true, value: getConfig()[prop] };
  },
});

export const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': '*/*',
};

function getUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}