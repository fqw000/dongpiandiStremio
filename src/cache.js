/**
 * 三级缓存：L1 内存 + L2 Upstash Redis + L3 Vercel CDN
 * Redis 连续 3 次慢响应（>500ms）或失败 → 60s 冷却期
 */

const memCache = new Map();
const MAX_MEM_SIZE = 200;
const L1_TTL = 60;
const REDIS_TIMEOUT = 800;
const REDIS_SLOW_THRESHOLD = 500;
const REDIS_COOLDOWN = 60000;
const REDIS_SLOW_TRIGGER = 3;

const UPSTASH_URL = typeof process !== 'undefined' ? process.env?.UPSTASH_REDIS_REST_URL : null;
const UPSTASH_TOKEN = typeof process !== 'undefined' ? process.env?.UPSTASH_REDIS_REST_TOKEN : null;
const REDIS_ENABLED = !!(UPSTASH_URL && UPSTASH_TOKEN);

let redisSlowCount = 0;
let redisCooldownUntil = 0;
let redisLogPrinted = false;

function logRedisStatus() {
  if (redisLogPrinted) return;
  redisLogPrinted = true;
  if (REDIS_ENABLED) console.log(`[Cache] ✅ Upstash Redis 已启用`);
  else console.warn(`[Cache] ⚠️ Upstash 未配置，仅使用内存缓存`);
}

function isRedisInCooldown() {
  return Date.now() < redisCooldownUntil;
}

function recordRedisSlow(elapsed, reason) {
  redisSlowCount++;
  if (redisSlowCount >= REDIS_SLOW_TRIGGER) {
    redisCooldownUntil = Date.now() + REDIS_COOLDOWN;
    console.warn(`[Cache] ⚠️ Redis ${reason} (${elapsed}ms × ${redisSlowCount})，冷却 60s`);
    redisSlowCount = 0;
  }
}

function recordRedisOk(elapsed) {
  if (elapsed <= REDIS_SLOW_THRESHOLD) redisSlowCount = 0;
  else recordRedisSlow(elapsed, '慢响应');
}

async function redisCommand(...args) {
  if (!REDIS_ENABLED || isRedisInCooldown()) return null;
  logRedisStatus();
  const start = Date.now();
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
    const elapsed = Date.now() - start;
    if (!res.ok) { recordRedisSlow(elapsed, 'HTTP 错误'); return null; }
    const data = await res.json();
    recordRedisOk(elapsed);
    return data.result;
  } catch (err) {
    recordRedisSlow(Date.now() - start, '失败');
    return null;
  }
}

export async function getCache(key) {
  const mem = memCache.get(key);
  if (mem && Date.now() <= mem.expireAt) return mem.data;
  if (mem) memCache.delete(key);

  if (REDIS_ENABLED && !isRedisInCooldown()) {
    const raw = await redisCommand('GET', key);
    if (raw !== null && raw !== undefined) {
      try {
        const data = JSON.parse(raw);
        console.log(`[Cache] ✅ L2 HIT: ${key}`);
        memCache.set(key, { data, expireAt: Date.now() + L1_TTL * 1000 });
        return data;
      } catch {}
    }
  }
  return null;
}

export async function setCache(key, data, ttlSeconds = 3600) {
  memCache.set(key, { data, expireAt: Date.now() + Math.min(ttlSeconds, L1_TTL) * 1000 });
  if (memCache.size > MAX_MEM_SIZE) {
    const first = memCache.keys().next().value;
    memCache.delete(first);
  }
  if (REDIS_ENABLED && !isRedisInCooldown()) {
    await redisCommand('SET', key, JSON.stringify(data), 'EX', ttlSeconds);
    console.log(`[Cache] ✅ L2 WRITE: ${key} (ttl=${ttlSeconds}s)`);
  }
}

export function clearCache() {
  const size = memCache.size;
  memCache.clear();
  console.log(`[Cache] 🧹 清空 L1 的 ${size} 个条目`);
}

export function getCacheStats() {
  return {
    l1Size: memCache.size,
    l1Keys: [...memCache.keys()].slice(0, 20),
    l2Enabled: REDIS_ENABLED,
    redisInCooldown: isRedisInCooldown(),
    redisCooldownRemain: isRedisInCooldown() ? Math.round((redisCooldownUntil - Date.now()) / 1000) : 0,
  };
}