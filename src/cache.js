/**
 * 三级缓存：L1 内存 + L2 Upstash Redis + L3 Vercel CDN
 *
 * 设计要点：
 *   - Key 带 APP_PREFIX 前缀，支持多项目共用同一 Redis 数据库
 *   - Redis 连续 3 次慢响应（>1500ms）或失败 → 60s 冷却期，期间只用 L1
 *   - 并发场景下，一旦触发冷却，同一批次其他请求不再重复计数
 *
 * @module cache
 */

import { CONFIG } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('Cache');

// ==========================================
// 常量
// ==========================================

/** L1 内存缓存 */
const memCache = new Map();
const MAX_MEM_SIZE = 200;
const L1_TTL = 60;                          // 秒

/** Redis 请求超时（毫秒）—— 比默认 800ms 放宽，避免本地/远地域误判 */
const REDIS_TIMEOUT = 2500;

/** Redis 慢响应阈值（毫秒）—— 超过这个值才计入慢统计 */
const REDIS_SLOW_THRESHOLD = 1500;

/** 冷却时长（毫秒） */
const REDIS_COOLDOWN = 60000;

/** 触发冷却的连续慢/失败次数 */
const REDIS_SLOW_TRIGGER = 3;

// ==========================================
// Upstash 配置
// ==========================================

const UPSTASH_URL = typeof process !== 'undefined'
  ? process.env?.UPSTASH_REDIS_REST_URL : null;
const UPSTASH_TOKEN = typeof process !== 'undefined'
  ? process.env?.UPSTASH_REDIS_REST_TOKEN : null;
const REDIS_ENABLED = !!(UPSTASH_URL && UPSTASH_TOKEN);

/** 日志只打印一次 */
let redisLogPrinted = false;
function logRedisStatus() {
  if (redisLogPrinted) return;
  redisLogPrinted = true;
  if (REDIS_ENABLED) log.info('Upstash Redis 已启用');
  else log.warn('Upstash 未配置，仅使用内存缓存');
}

// ==========================================
// Key 前缀
// ==========================================

/**
 * 为 Redis Key 加项目前缀，避免多项目共用数据库时冲突
 * 例：key('catalog', 'dpd-movie', 0) → 'dongpiandi:prod:catalog:dpd-movie:0'
 *
 * @param  {...(string|number)} parts
 * @returns {string}
 */
function prefixKey(...parts) {
  const prefix = CONFIG.APP_PREFIX || 'dongpiandi:prod';
  return [prefix, ...parts].join(':');
}

// ==========================================
// Redis 健康状态
// ==========================================

let redisSlowCount = 0;
let redisCooldownUntil = 0;

function isRedisInCooldown() {
  return Date.now() < redisCooldownUntil;
}

/**
 * 记录慢响应/失败
 *
 * 关键：如果当前已在冷却期，则不再计数。
 * 这解决了 Promise.all 并发时，同一批请求全部超时后连续触发多次冷却日志的问题。
 */
function recordRedisSlow(elapsed, reason) {
  if (isRedisInCooldown()) return;   // 已在冷却期，跳过
  redisSlowCount++;
  if (redisSlowCount >= REDIS_SLOW_TRIGGER) {
    redisCooldownUntil = Date.now() + REDIS_COOLDOWN;
    log.warn(`Redis ${reason} (${elapsed}ms × ${redisSlowCount})，冷却 ${REDIS_COOLDOWN / 1000}s`);
    redisSlowCount = 0;
  }
}

function recordRedisOk(elapsed) {
  if (elapsed <= REDIS_SLOW_THRESHOLD) {
    redisSlowCount = 0;
  } else {
    recordRedisSlow(elapsed, '慢响应');
  }
}

// ==========================================
// Upstash REST API
// ==========================================

/**
 * 执行 Redis 命令
 *
 * @param {...(string|number)} args - 如 ('GET', 'key')、('SET', 'key', 'val', 'EX', 300)
 * @returns {Promise<any|null>}
 */
async function redisCommand(...args) {
  if (!REDIS_ENABLED) return null;
  if (isRedisInCooldown()) return null;

  logRedisStatus();

  const startTime = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REDIS_TIMEOUT);

    const res = await fetch(UPSTASH_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const elapsed = Date.now() - startTime;

    // 请求期间已进入冷却期 → 不再计数（并发保护）
    if (isRedisInCooldown()) return null;

    if (!res.ok) {
      recordRedisSlow(elapsed, 'HTTP 错误');
      return null;
    }

    const data = await res.json();
    recordRedisOk(elapsed);
    return data.result;
  } catch (err) {
    if (isRedisInCooldown()) return null;
    recordRedisSlow(Date.now() - startTime, '失败');
    return null;
  }
}

// ==========================================
// 对外接口
// ==========================================

/**
 * 读取缓存（L1 → L2）
 *
 * @param {string} key - 未加前缀的逻辑 key，如 'detail:av_xxx'
 * @returns {Promise<any|null>}
 */
export async function getCache(key) {
  // ===== L1 =====
  const mem = memCache.get(key);
  if (mem && Date.now() <= mem.expireAt) return mem.data;
  if (mem) memCache.delete(key);

  // ===== L2 =====
  if (REDIS_ENABLED && !isRedisInCooldown()) {
    const redisKey = prefixKey(key);
    const raw = await redisCommand('GET', redisKey);
    if (raw !== null && raw !== undefined) {
      try {
        const data = JSON.parse(raw);
        log.debug(`L2 HIT: ${redisKey}`);
        memCache.set(key, { data, expireAt: Date.now() + L1_TTL * 1000 });
        return data;
      } catch (err) {
        log.warn(`L2 反序列化失败: ${redisKey}`);
      }
    }
  }

  return null;
}

/**
 * 写入缓存（同时写 L1 + L2）
 *
 * @param {string} key - 未加前缀的逻辑 key
 * @param {any} data - 可 JSON 序列化的数据
 * @param {number} ttlSeconds - 秒
 */
export async function setCache(key, data, ttlSeconds = 3600) {
  // ===== L1 =====
  memCache.set(key, {
    data,
    expireAt: Date.now() + Math.min(ttlSeconds, L1_TTL) * 1000,
  });
  if (memCache.size > MAX_MEM_SIZE) {
    const firstKey = memCache.keys().next().value;
    memCache.delete(firstKey);
  }

  // ===== L2 =====
  if (REDIS_ENABLED && !isRedisInCooldown()) {
    const redisKey = prefixKey(key);
    await redisCommand('SET', redisKey, JSON.stringify(data), 'EX', ttlSeconds);
    log.debug(`L2 WRITE: ${redisKey} (ttl=${ttlSeconds}s)`);
  }
}

/**
 * 删除缓存
 */
export async function deleteCache(key) {
  memCache.delete(key);
  if (REDIS_ENABLED && !isRedisInCooldown()) {
    await redisCommand('DEL', prefixKey(key));
  }
}

export function clearCache() {
  const size = memCache.size;
  memCache.clear();
  log.info(`清空 L1 的 ${size} 个条目`);
}

export function getCacheStats() {
  return {
    l1Size: memCache.size,
    l1Keys: [...memCache.keys()].slice(0, 20),
    l2Enabled: REDIS_ENABLED,
    appPrefix: CONFIG.APP_PREFIX,
    redisInCooldown: isRedisInCooldown(),
    redisCooldownRemain: isRedisInCooldown()
      ? Math.round((redisCooldownUntil - Date.now()) / 1000)
      : 0,
  };
}