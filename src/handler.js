/**
 * Stremio Addon 主处理
 *
 * 路由：
 *   GET /manifest.json[?cfg=...]
 *   GET /catalog/:type/:id[/<extras>].json[?cfg=...]
 *   GET /meta/:type/:id.json[?cfg=...]
 *   GET /stream/:type/:id.json[?cfg=...]
 *   GET /debug/cache
 *   GET /debug/version
 *
 * ID 格式：
 *   dpd_{vodId}            → 影片级（电影，或剧集默认 S1E1）
 *   dpd_{vodId}:1:5        → 集级（剧集第 1 季第 5 集）
 *   tt0109830              → IMDb 影片级
 *   tt0109830:1:5          → IMDb 集级
 */

import { createLogger, setLogLevel, resetLogLevel, getLogLevel } from './logger.js';
import { CONFIG, getConfig } from './config.js';
import { generateManifest } from './manifest.js';
import { fetchCatalog, fetchDetail, fetchEpisodes, resolveStream, searchVideos, CATALOG_MAP } from './adapter.js';
import { getCacheStats } from './cache.js';
import { decodeBase64Url } from './helper.js';
import { resolveImdbToVod } from './imdb-resolver.js';


const log = createLogger('Handler');

// ==========================================
// 入口
// ==========================================

export async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // ===== 请求级日志级别控制 =====
  if (url.searchParams.get('debug') === '1') setLogLevel('debug');

  try {
    // ===== 用户配置注入 =====
    applyUserConfig(url);

    log.info(`${request.method} ${pathname}${url.search ? ' ' + url.search.slice(0, 120) : ''}`);

    // ===== 路由 =====
    if (pathname === '/manifest.json') return handleManifest();

    const catalogMatch = pathname.match(/^\/catalog\/(movie|series)\/([^/]+?)(?:\/([^/]+))?\.json$/);
    if (catalogMatch) return await handleCatalog(catalogMatch[1], catalogMatch[2], catalogMatch[3], url);

    const metaMatch = pathname.match(/^\/meta\/(movie|series)\/([^/]+)\.json$/);
    if (metaMatch) return await handleMeta(metaMatch[1], metaMatch[2]);

    const streamMatch = pathname.match(/^\/stream\/(movie|series)\/([^/]+)\.json$/);
    if (streamMatch) return await handleStream(streamMatch[1], streamMatch[2]);

    // ===== Debug =====
    if (pathname === '/debug/cache') return jsonResponse(getCacheStats());
    if (pathname === '/debug/version') return jsonResponse({ version: '1.0.0', logLevel: getLogLevel() });
    if (pathname === '/debug/config') return jsonResponse(redactConfig(getConfig()));

    log.warn(`404 ${pathname}`);
    return new Response('Not Found', { status: 404 });
  } finally {
    resetLogLevel();
  }
}

export default { fetch: handleRequest };

// ==========================================
// 用户配置
// ==========================================

function applyUserConfig(url) {
  const cfgB64 = url.searchParams.get('cfg');
  if (!cfgB64) {
    globalThis.__USER_CONFIG = {};
    return;
  }
  try {
    const json = decodeBase64Url(cfgB64);
    const cfg = JSON.parse(json);
    globalThis.__USER_CONFIG = cfg;
    log.info('user config loaded', cfg);
    // 如果用户配置了 debug，也可以打开
    if (cfg.debug === true) setLogLevel('debug');
  } catch (err) {
    log.warn('cfg parse failed', err.message);
    globalThis.__USER_CONFIG = {};
  }
}

// ==========================================
// Manifest
// ==========================================

function handleManifest() {
  const manifest = generateManifest({
    enabledCategories: CONFIG.ENABLED_CATEGORIES,
    enableStream: CONFIG.ENABLE_STREAM !== false,
  });
  return jsonResponse(manifest, 0);
}

// ==========================================
// Catalog
// ==========================================

async function handleCatalog(routeType, catalogId, extraPath, url) {
  const extras = parseExtras(extraPath, url);
  log.info(`catalog routeType=${routeType} catalogId=${catalogId} extras=${JSON.stringify(extras)}`);

  // 搜索走独立分支
  if (extras.search) {
    return await handleCatalogSearch(routeType, catalogId, extras.search);
  }

  const skip = extras.skip ? parseInt(extras.skip, 10) || 0 : 0;
  const items = await fetchCatalog(catalogId, skip, {
    genre: extras.genre,
    year: extras.year,
    sort: extras.sort,
  });

  const meta = CATALOG_MAP[catalogId];
  const isMovieCatalog = meta?.stremioType === 'movie';

  const metas = items.map(item => {
    // catalog 已声明类型，不需要再靠 totalEpisodeCount 猜
    const isSeries = !isMovieCatalog;
    const id = isSeries ? `dpd_${item.vodId}:1:1` : `dpd_${item.vodId}`;
    return {
      id,
      type: isSeries ? 'series' : 'movie',
      name: item.vodName,
      poster: item.vodPic || '',
      releaseInfo: item.year || '',
      description: item.vodRemarks || '',
      genres: item.genres || [],
    };
  });

  log.info(`catalog ok: ${metas.length} metas, skip=${skip}`);
  return jsonResponse({ metas }, 300);
}

// /**
//  * 处理 catalog 内的搜索请求
//  *
//  * 搜索结果按 kind 判定类型，与请求的 routeType 匹配后返回。
//  * 不用 totalEpisodeCount 判断（电影也返回 1，不可靠）。
//  *
//  * @param {string} routeType - 'movie' | 'series'（来自 URL）
//  * @param {string} catalogId - catalog id（如 dpd-movie）
//  * @param {string} query - 搜索关键词
//  */
// async function handleCatalogSearch(routeType, catalogId, query) {
//   const results = await searchVideos(query, 24);

//   // ===== 过滤：电影只保留 kind='movie'，剧集保留其他 =====
//   const filtered = results.filter(item => {
//     return routeType === 'movie' ? item.isMovie === true : item.isMovie === false;
//   });

//   const metas = filtered.map(item => ({
//     // 电影用影片级 id，剧集用集级 id
//     id: item.isMovie ? `dpd_${item.vodId}` : `dpd_${item.vodId}:1:1`,
//     type: item.isMovie ? 'movie' : 'series',
//     name: item.vodName,
//     poster: item.vodPic || '',
//     releaseInfo: item.vodYear || '',
//     description: item.vodRemarks || '',
//   }));

//   log.info(`search ok: "${query}" → ${metas.length} metas (routeType=${routeType}, raw=${results.length})`);
//   return jsonResponse({ metas }, 300);
// }

/**
 * 处理 catalog 内的搜索请求
 *
 * 直接调懂片帝的 query_mode=fast_v3 一步搜索，按 catalogId 推导 kind 过滤。
 * 服务端已按 kind 过滤，返回的 cards 类型精确，无需再在本地过滤。
 *
 * @param {string} routeType - 'movie' | 'series'（来自 URL，仅用于日志）
 * @param {string} catalogId - catalog id（如 dpd-movie）
 * @param {string} query - 搜索关键词
 */
async function handleCatalogSearch(routeType, catalogId, query) {
  const catMeta = CATALOG_MAP[catalogId];
  const kind = catMeta?.kind || '';

  const results = await searchVideos(query, kind, 1);

  const metas = results.map(item => ({
    // 电影用影片级 id，其他类型用集级 id（Stremio series 规范）
    id: item.isMovie ? `dpd_${item.vodId}` : `dpd_${item.vodId}:1:1`,
    type: item.isMovie ? 'movie' : 'series',
    name: item.vodName,
    poster: item.vodPic || '',
    releaseInfo: item.vodYear || '',
    description: item.vodRemarks || '',
  }));

  log.info(`search ok: "${query}" kind=${kind || 'all'} → ${metas.length} metas`);
  return jsonResponse({ metas }, 300);
}



// ==========================================
// Meta
// ==========================================

async function handleMeta(routeType, rawEncodedId) {
  const parsed = parseId(rawEncodedId);
  log.info(`meta source=${parsed.source} vodId=${parsed.vodId || parsed.imdbId}`);


  // ===== IMDb → vodId =====
  let resolvedMeta = null;
  if (parsed.source === 'imdb') {
    if (CONFIG.ENABLE_IMDB === false) {
      log.info('IMDb 解析已禁用');
      return jsonResponse({ meta: null });
    }
    resolvedMeta = await resolveImdbToVod(parsed.imdbId, routeType, parsed.season);
    if (!resolvedMeta) {
      log.warn(`IMDb 解析失败: ${parsed.imdbId}`);
      return jsonResponse({ meta: null });
    }
    parsed.vodId = resolvedMeta.vodId;
    log.info(`IMDb → vodId: ${parsed.imdbId} → ${parsed.vodId}`);
  }

  // ===== 拉详情 =====
  const detail = await fetchDetail(parsed.vodId);
  if (!detail) {
    log.warn(`详情为空: ${parsed.vodId}`);
    return jsonResponse({ meta: null });
  }


  // 懂片帝对电影也返回 total_episode_count=1，无法用此区分
  // Stremio 路由类型（movie/series）是更可靠的判断依据
  const isSeries = routeType === 'series';
  const metaId = parsed.source === 'imdb' ? parsed.imdbId : `dpd_${parsed.vodId}`;

  const meta = {
    id: metaId,
    type: isSeries ? 'series' : 'movie',
    name: detail.vodName,
    description: detail.vodContent || '暂无描述',
    poster: detail.vodPic || '',
    background: detail.vodPic || '',
    year: detail.vodYear || '',
    releaseInfo: detail.vodYear || '',
    genres: detail.vodGenres || [],
    director: detail.vodDirectors || [],
    cast: (detail.vodActors || []).slice(0, 10),
    runtime: detail.vodRemarks || '',
  };

  if (!isSeries) {
    meta.videos = [{
      id: metaId,
      title: detail.vodName,
      thumbnail: detail.vodPic || '',
    }];
    log.info(`meta ok (movie): "${meta.name}"`);
    return jsonResponse({ meta }, 600);
  }

  // 剧集：拉选集
  const episodes = await fetchEpisodes(parsed.vodId);
  if (episodes.length > 0) {
    const fallbackThumb = detail.vodPic || '';

    // video id 前缀必须与 meta.id 同源，否则 Stremio 客户端
    // 从 meta 页面点第 N 集时，会拿 dpd_ 前缀去请求 stream 接口，
    // 与 IMDb 缓存、跨 Addon 协作都脱节。
    const isImdb = parsed.source === 'imdb';
    const videoIdPrefix = isImdb
      ? `${parsed.imdbId}:${parsed.season || 1}`
      : `dpd_${parsed.vodId}:1`;
    const videoSeason = isImdb ? (parsed.season || 1) : 1;

    meta.videos = episodes.map((ep, idx) => ({
      id: `${videoIdPrefix}:${idx + 1}`,
      season: videoSeason,
      episode: idx + 1,
      title: ep.title || `第${idx + 1}集`,
      thumbnail: fallbackThumb,
      released: new Date().toISOString(),
    }));
    // 关键：videos 之后再设置 defaultVideoId
    meta.behaviorHints = { defaultVideoId: meta.videos[0].id };
  } else {
    meta.videos = [];
  }

  log.info(`meta ok (series): "${meta.name}", videos=${meta.videos.length}`);
  return jsonResponse({ meta }, 600);
}

// ==========================================
// Stream
// ==========================================

async function handleStream(routeType, rawEncodedId) {
  if (CONFIG.ENABLE_STREAM === false) {
    log.info('stream disabled by config');
    return jsonResponse({ streams: [] });
  }

  const parsed = parseId(rawEncodedId);
  log.info(`stream source=${parsed.source} id=${parsed.vodId || parsed.imdbId} ep=${parsed.episode}`);

  // ===== IMDb → vodId =====
  if (parsed.source === 'imdb') {
    if (CONFIG.ENABLE_IMDB === false) {
      return jsonResponse({ streams: [] });
    }
    const resolved = await resolveImdbToVod(parsed.imdbId, routeType, parsed.season);
    if (!resolved) {
      log.warn(`IMDb 解析失败: ${parsed.imdbId}`);
      return jsonResponse({ streams: [] });
    }
    parsed.vodId = resolved.vodId;
    // 关键：IMDb 已解析出 vodId，source 改成 dpd 以通过后续流程
    parsed.source = 'dpd';
  }

  if (parsed.source !== 'dpd') {
    log.warn(`stream source=${parsed.source} not implemented yet`);
    return jsonResponse({ streams: [] });
  }

  // ===== 1. 拿选集列表 =====
  const episodes = await fetchEpisodes(parsed.vodId);
  if (episodes.length === 0) {
    log.warn(`stream no episodes for vodId=${parsed.vodId}`);
    return jsonResponse({ streams: [] });
  }

  // ===== 2. 定位目标集 =====
  let targetEp = null;
  if (parsed.hasSeasonEpisode && parsed.episode > 0) {
    targetEp = episodes.find((_, i) => i + 1 === parsed.episode);
    if (!targetEp) {
      log.warn(`episode ${parsed.episode} out of range, using ep1`);
      targetEp = episodes[0];
    }
  } else {
    targetEp = episodes[0];
  }

  if (!targetEp || !targetEp.token) {
    log.warn('no valid token');
    return jsonResponse({ streams: [] });
  }

  // ===== 3. 解析线路 =====
  const lines = await resolveStream(targetEp.token);
  if (lines.length === 0) {
    log.warn('no playable lines (all resolve_required)');
    return jsonResponse({ streams: [] });
  }

  // ===== 4. 影片名（用于 stream.name）=====
  const detail = await fetchDetail(parsed.vodId);
  const movieName = detail?.vodName || '懂片帝';

  // ===== 5. 组装 Stremio streams =====
  // 保险过滤：只让 http(s) 开头的 url 通过，避免脏数据传给播放器
  const validLines = lines.filter(line => {
    if (!line.url || !/^https?:\/\//.test(line.url)) {
      log.warn(`剔除非法 url: ${String(line.url).slice(0, 60)}`);
      return false;
    }
    return true;
  });

  const streams = validLines.map(line => {
    const isHls = line.url.includes('.m3u8');
    return {
      name: movieName,
      title: line.name,
      url: line.url,
      behaviorHints: {
        notWebReady: false,
        bingeGroup: `dpd-${parsed.vodId}-${line.playFrom || line.name}`,
      },
      ...(isHls ? { type: 'hls' } : {}),
    };
  });

  // 根据 URL 域名判断实际模式
  let mode = CONFIG.SESSION_COOKIE ? 'Cookie' : '匿名';
  if (streams.length > 0) {
    const u = streams[0].url;
    if (/byteimg|toutiaovod|heycan/.test(u)) mode += '·官方';
    else if (/\.m3u8/.test(u)) mode += '·m3u8回退';
  } else {
    mode += '·无结果';
  }
  log.info(`stream ok: ${streams.length} 条线路返回（${mode}）`);

  return jsonResponse({ streams }, 60);
}

// ==========================================
// ID 解析
// ==========================================

function parseId(rawEncodedId) {
  const rawId = decodeURIComponent(rawEncodedId);

  // ===== IMDb =====
  if (rawId.startsWith('tt')) {
    const parts = rawId.split(':');
    return {
      source: 'imdb',
      imdbId: parts[0],
      season: parts[1] !== undefined ? (parseInt(parts[1], 10) || 1) : 1,
      episode: parts[2] !== undefined ? (parseInt(parts[2], 10) || 1) : 1,
      hasSeasonEpisode: parts.length >= 3,
      rawId,
    };
  }

  // ===== 懂片帝 =====
  if (rawId.startsWith('dpd_')) {
    const rest = rawId.slice(4);
    const parts = rest.split(':');
    return {
      source: 'dpd',
      vodId: parts[0],
      season: parts[1] !== undefined ? (parseInt(parts[1], 10) || 1) : 1,
      episode: parts[2] !== undefined ? (parseInt(parts[2], 10) || 1) : 1,
      hasSeasonEpisode: parts.length >= 3,
      rawId,
    };
  }

  return { source: 'unknown', rawId };
}

// ==========================================
// Extras 解析
// ==========================================

/**
 * 支持两种形式：
 *   /catalog/movie/dpd-movie/skip=20&genre=动作.json
 *   /catalog/movie/dpd-movie.json?skip=20&genre=动作
 */
function parseExtras(extraPath, url) {
  const extras = {};
  if (extraPath) {
    for (const part of extraPath.split('&')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const k = part.slice(0, eq);
      const v = decodeURIComponent(part.slice(eq + 1));
      extras[k] = v;
    }
  }
  for (const key of ['skip', 'search', 'genre', 'year', 'sort']) {
    const qv = url.searchParams.get(key);
    if (qv !== null && extras[key] === undefined) extras[key] = qv;
  }
  return extras;
}

// ==========================================
// 响应
// ==========================================

function jsonResponse(data, cacheSeconds = 0) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  };
  if (cacheSeconds > 0) {
    headers['Cache-Control'] = `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 2}`;
  } else {
    headers['Cache-Control'] = 'public';
  }
  return new Response(JSON.stringify(data, null, 2), { headers });
}

/** 脱敏配置，仅用于 debug 输出 */
function redactConfig(cfg) {
  const out = { ...cfg };
  if (out.API_KEY) out.API_KEY = out.API_KEY.slice(0, 8) + '***';
  if (out.TMDB_API_KEY) out.TMDB_API_KEY = out.TMDB_API_KEY.slice(0, 8) + '***';
  if (out.SESSION_COOKIE) {
    out.SESSION_COOKIE = out.SESSION_COOKIE.slice(0, 8) + '***(len=' + out.SESSION_COOKIE.length + ')';
  } else {
    out.SESSION_COOKIE = '(empty)';
  }
  return out;
}