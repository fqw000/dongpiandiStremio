/**
 * 全局配置
 * 用户配置通过 globalThis.__USER_CONFIG 注入（base64url cfg 参数）
 */

function getUserConfig() {
  return (typeof globalThis !== 'undefined' && globalThis.__USER_CONFIG) || {};
}

const ALL_CATEGORIES = ['movie', 'series', 'short', 'anime', 'variety', 'documentary'];

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
    BASE_DOMAIN: user.bd || 'dongpian20.com',
    USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    API_KEY: '8b9a908a05eac640e1ee06f52acaa741bfe4ba9e004eeffdbeb635e532e06666',
    TMDB_API_KEY: user.tk || 'e5c3c7269a147fee368c3649ddd98875',
    DEVICE_ID: getUUID(),
    ENABLE_IMDB: user.imdb !== false,
    ENABLE_STREAM: user.stream !== false,
    ENABLED_CATEGORIES: enabledCategories,
    REQUEST_TIMEOUT: 15000,
    RETRY_COUNT: 1,
    RETRY_DELAY: 300,
    PAGE_SIZE: 20,
    MATCH_THRESHOLD: 0.5,
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