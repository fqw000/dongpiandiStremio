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
    if (pathname === '/debug/cache')    return jsonResponse(getCacheStats());
    if (pathname === '/debug/version')  return jsonResponse({ version: '1.0.0', logLevel: getLogLevel() });
    if (pathname === '/debug/config')   return jsonResponse(redactConfig(getConfig()));

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
    const isSeries = !isMovieCatalog || (item.totalEpisodeCount || 0) > 0;
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

async function handleCatalogSearch(routeType, catalogId, query) {
  const results = await searchVideos(query, 24);
  const metas = results
    .map(item => {
      const isSeries = (item.totalEpisodeCount || 0) > 0;
      return {
        id: isSeries ? `dpd_${item.vodId}:1:1` : `dpd_${item.vodId}`,
        type: isSeries ? 'series' : 'movie',
        name: item.vodName,
        poster: item.vodPic || '',
        releaseInfo: item.vodYear || '',
        description: item.vodRemarks || '',
      };
    })
    .filter(m => m.type === routeType);

  log.info(`search ok: "${query}" → ${metas.length} metas (routeType=${routeType})`);
  return jsonResponse({ metas }, 300);
}

// ==========================================
// Meta
// ==========================================

async function handleMeta(routeType, rawEncodedId) {
  const parsed = parseId(rawEncodedId);
  log.info(`meta source=${parsed.source} vodId=${parsed.vodId || parsed.imdbId}`);

  if (parsed.source !== 'dpd') {
    // IMDb 在下一轮 imdb-resolver 中实现
    log.warn(`meta source=${parsed.source} not implemented yet`);
    return jsonResponse({ meta: null });
  }

  const detail = await fetchDetail(parsed.vodId);
  if (!detail) {
    log.warn(`meta detail not found: ${parsed.vodId}`);
    return jsonResponse({ meta: null });
  }

  const isSeries = routeType === 'series' || (detail.totalEpisodeCount || 0) > 0;
  const metaId = `dpd_${parsed.vodId}`;

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
    meta.videos = episodes.map((ep, idx) => ({
      id: `dpd_${parsed.vodId}:1:${idx + 1}`,
      season: 1,
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
  log.info(`stream source=${parsed.source} vodId=${parsed.vodId} ep=${parsed.episode}`);

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
  const streams = lines.map(line => {
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

  log.info(`stream ok: ${streams.length} lines`);
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
  return out;
}