/**
 * TMDB + Cinemeta 元数据
 *
 * 用途：IMDb → 懂片帝 vodId 的第一步——拿到标准化的标题、年份、季数、别名。
 * 主源：TMDB（需要 API Key，从 CONFIG.TMDB_API_KEY 读）
 * 备源：Cinemeta（无需 Key）
 *
 * @module tmdb
 */

import { CONFIG } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('TMDB');

// ==========================================
// 工具
// ==========================================


function extractYear(dateStr) {
  if (!dateStr) return null;
  const y = parseInt(String(dateStr).split('-')[0], 10);
  return isNaN(y) ? null : y;
}

// ==========================================
// TMDB
// ==========================================

/**
 * 通过 IMDb ID 从 TMDB 查询元数据
 *
 * @param {string} imdbId - 形如 'tt0109830'
 * @param {string} type - 'movie' 或 'series'
 * @returns {Promise<Object|null>}
 */
export async function fetchFromTMDB(imdbId, type) {
  if (!CONFIG.TMDB_API_KEY) {
    log.warn('TMDB_API_KEY 未配置');
    return null;
  }

  const mediaType = type === 'movie' ? 'movie' : 'tv';
  const key = CONFIG.TMDB_API_KEY;

  try {
    // Step 1: find by imdb_id
    const findUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${key}&external_source=imdb_id&language=zh-CN`;
    const findResp = await fetchWithRetry(findUrl);
    if (!findResp.ok) {
      log.warn(`find failed: HTTP ${findResp.status}`);
      return null;
    }
    const findData = await findResp.json();
    const result = type === 'movie'
      ? findData.movie_results?.[0]
      : findData.tv_results?.[0];

    if (!result) {
      log.info(`TMDB 未收录: ${imdbId}`);
      return null;
    }

    const tmdbId = result.id;

    // Step 2: 拉详情（含 season_count）
    let detailData = null;
    if (type !== 'movie') {
      const detailUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${key}&language=zh-CN`;
      try {
        const detailResp = await fetchWithRetry(detailUrl);
        if (detailResp.ok) detailData = await detailResp.json();
      } catch (err) {
        log.warn(`detail 拉取失败: ${err.message}`);
      }
    }

    const meta = {
      imdbId,
      tmdbId,
      type,
      title: result.title || result.name || '',
      originalTitle: result.original_title || result.original_name || '',
      year: extractYear(result.release_date || result.first_air_date),
      overview: result.overview || '',
      poster: result.poster_path ? `https://image.tmdb.org/t/p/w500${result.poster_path}` : '',
      background: result.backdrop_path ? `https://image.tmdb.org/t/p/original${result.backdrop_path}` : '',
      rating: result.vote_average || 0,
      seasonCount: detailData?.number_of_seasons || 0,
      episodeCount: detailData?.number_of_episodes || 0,
    };

    log.info(`TMDB 命中: ${imdbId} → tmdbId=${tmdbId} "${meta.title}" (${meta.year}) seasons=${meta.seasonCount}`);
    return meta;
  } catch (err) {
    log.warn(`TMDB 请求异常: ${err.message}`);
    return null;
  }
}

/**
 * 获取 TMDB 剧集的全部别名标题
 *
 * @param {number} tmdbId
 * @param {string} type - 'movie' 或 'series'
 * @returns {Promise<string[]>}
 */
export async function fetchAlternativeTitles(tmdbId, type) {
  if (!tmdbId || !CONFIG.TMDB_API_KEY) return [];

  const mediaType = type === 'movie' ? 'movie' : 'tv';
  const url = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/alternative_titles?api_key=${CONFIG.TMDB_API_KEY}`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      log.warn(`alternative_titles HTTP ${resp.status}`);
      return [];
    }
    const data = await resp.json();
    const arr = data.titles || data.results || [];
    if (!Array.isArray(arr)) return [];

    const set = new Set();
    for (const item of arr) {
      const t = String(item.title || '').trim();
      if (t) set.add(t);
    }
    const result = [...set];
    log.debug(`alternative_titles: ${result.length} 个`);
    return result;
  } catch (err) {
    log.warn(`alternative_titles 异常: ${err.message}`);
    return [];
  }
}

/**
 * 通过标题在 TMDB 搜索剧集（用于从站内 ID 反查 TMDB ID，为剧集缩略图服务）
 *
 * @param {string} title
 * @param {number|null} year
 * @returns {Promise<number|null>}
 */
export async function searchTmdbByTitle(title, year = null) {
  if (!title || !CONFIG.TMDB_API_KEY) return null;

  try {
    const encoded = encodeURIComponent(title);
    const url = `https://api.themoviedb.org/3/search/tv?query=${encoded}&api_key=${CONFIG.TMDB_API_KEY}&language=zh-CN${year ? `&first_air_date_year=${year}` : ''}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    const results = data.results || [];
    if (results.length === 0) return null;

    // 年份精确优先
    let matched = null;
    if (year) {
      matched = results.find(r => extractYear(r.first_air_date) === year);
    }
    if (!matched) matched = results[0];
    return matched.id;
  } catch {
    return null;
  }
}

/**
 * 带超时和重试的 fetch
 *
 * 场景：Vercel Edge 到 TMDB 偶发连接超时（undici 约 10s 超时），
 * 一次失败就放弃会导致 IMDb 解析整体失败。加一次重试显著提高成功率。
 *
 * @param {string} url
 * @param {number} timeoutMs - 单次请求超时
 * @param {number} retries - 重试次数（不含首次）
 */
async function fetchWithRetry(url, timeoutMs = 8000, retries = 1) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (i < retries) {
        log.debug(`TMDB 请求失败，${500}ms 后重试: ${err.message}`);
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }
  throw lastErr;
}



// ==========================================
// Cinemeta（备用）
// ==========================================

export async function fetchFromCinemeta(imdbId, type) {
  const hosts = [
    'https://v3-cinemeta.strem.io',
    'https://cinemeta-live.strem.fun',
  ];

  for (const host of hosts) {
    try {
      const url = `${host}/${type}/${imdbId}.json`;
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const data = await resp.json();
      const meta = data?.meta;
      if (!meta) continue;

      // 中文别名优先
      let title = meta.name || '';
      if (Array.isArray(meta.aliases)) {
        const cn = meta.aliases.find(a => typeof a === 'string' && /[\u4e00-\u9fa5]/.test(a));
        if (cn) title = cn;
      }

      return {
        imdbId,
        type,
        title,
        originalTitle: meta.name || '',
        year: meta.year ? parseInt(meta.year, 10) : null,
        overview: meta.description || '',
        poster: meta.poster || '',
        background: meta.background || meta.poster || '',
        rating: meta.imdbRating || 0,
        seasonCount: meta.seasonCount || 0,
      };
    } catch {
      continue;
    }
  }
  return null;
}

// ==========================================
// 统一入口
// ==========================================

/**
 * 获取 IMDb 元数据（TMDB 优先，Cinemeta 兜底）
 */
export async function fetchImdbMeta(imdbId, type) {
  const tmdb = await fetchFromTMDB(imdbId, type);
  if (tmdb && tmdb.title) return tmdb;

  log.info(`TMDB 无结果，尝试 Cinemeta: ${imdbId}`);
  const cine = await fetchFromCinemeta(imdbId, type);
  if (cine && cine.title) return cine;

  log.warn(`所有元数据源失败: ${imdbId}`);
  return null;
}