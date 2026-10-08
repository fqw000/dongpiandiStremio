/**
 * 懂片帝站点适配器
 *
 * 接口（基于 Python Spider 实测）：
 *   分类 /v1/browse/catalog?kind=&page=&limit=&genre=&area=&year=&sort=
 *   详情 /v1/catalog/{id}
 *   选集 /v1/catalog/{id}/episodes
 *   解析 /v1/playback/resolve/{token}?view=compact
 *   搜索 /v1/suggest?q=&limit=
 */

import { apiGet } from './http.js';
import { getCache, setCache } from './cache.js';
import { CONFIG } from './config.js';

const PAGE_LIMIT = 20;

export const CATALOG_MAP = {
  'dpd-movie':       { kind: 'movie',       stremioType: 'movie'  },
  'dpd-series':      { kind: 'series',      stremioType: 'series' },
  'dpd-short':       { kind: 'short_drama', stremioType: 'series' },
  'dpd-anime':       { kind: 'anime',       stremioType: 'series' },
  'dpd-variety':     { kind: 'variety',     stremioType: 'series' },
  'dpd-documentary': { kind: 'documentary', stremioType: 'series' },
};

/**
 * 从 detail_url 提取 vodId
 *   '/v1/catalog/av_xxx' → 'av_xxx'
 *   'av_xxx'             → 'av_xxx'
 */
export function extractVodId(detailUrl) {
  let id = String(detailUrl || '').trim();
  if (id.startsWith('/v1/catalog/')) id = id.slice('/v1/catalog/'.length);
  const q = id.indexOf('?');
  if (q >= 0) id = id.slice(0, q);
  return id;
}

export async function fetchCatalog(catalogId, skip = 0, extras = {}) {
  const cacheKey = `catalog:${catalogId}:${skip}:${JSON.stringify(extras)}`;
  const cached = await getCache(cacheKey);
  if (cached) {
    console.log(`[Adapter] ✅ Catalog 缓存命中: ${cacheKey} (${cached.length} 条)`);
    return cached;
  }

  const meta = CATALOG_MAP[catalogId];
  if (!meta) return [];

  const page = Math.floor(skip / PAGE_LIMIT) + 1;
  const params = new URLSearchParams({
    kind: meta.kind,
    page: String(page),
    limit: String(PAGE_LIMIT),
  });
  if (extras.genre) params.set('genre', extras.genre);
  if (extras.area) params.set('area', extras.area);
  if (extras.year) params.set('year', extras.year);
  if (extras.sort) params.set('sort', extras.sort);

  const path = '/v1/browse/catalog?' + params.toString();
  const data = await apiGet(path);
  if (!data || !Array.isArray(data.cards)) return [];

  const items = data.cards.map(card => ({
    vodId: extractVodId(card.detail_url),
    vodName: card.title || '',
    vodPic: card.poster_url || '',
    vodRemarks: card.remarks || card.year || '',
    year: String(card.year || ''),
    area: card.area || '',
    genres: Array.isArray(card.genres) ? card.genres : [],
  })).filter(x => x.vodId && x.vodName);

  await setCache(cacheKey, items, 300);
  return items;
}

export async function fetchDetail(vodId) {
  const cacheKey = `detail:${vodId}`;
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  const path = '/v1/catalog/' + encodeURIComponent(vodId);
  const data = await apiGet(path);
  if (!data || !data.title) return null;

  const detail = {
    vodId,
    vodName: data.title || '',
    vodPic: data.poster_url || '',
    vodContent: data.description || '',
    vodYear: String(data.year || ''),
    vodArea: data.area || '',
    vodGenres: Array.isArray(data.genres) ? data.genres : [],
    vodActors: Array.isArray(data.actors) ? data.actors : [],
    vodDirectors: Array.isArray(data.directors) ? data.directors : [],
    vodRemarks: data.remarks || '',
    totalEpisodeCount: Number(data.total_episode_count) || 0,
  };

  await setCache(cacheKey, detail, 1800);
  return detail;
}

export async function fetchEpisodes(vodId) {
  const cacheKey = `episodes:${vodId}`;
  const cached = await getCache(cacheKey);
  if (cached) {
    console.log(`[Adapter] ✅ Episodes 缓存命中: ${vodId} (${cached.length} 集)`);
    return cached;
  }

  const path = `/v1/catalog/${encodeURIComponent(vodId)}/episodes`;
  const data = await apiGet(path);

  let episodes = Array.isArray(data?.episodes) ? data.episodes : [];

  // 分页兜底
  if (data?.episode_pagination?.has_more) {
    let offset = data.episode_pagination.returned_count || episodes.length;
    let guard = 0;
    while (guard < 5) {
      const nextPath = `/v1/catalog/${encodeURIComponent(vodId)}/episodes?offset=${offset}&limit=48`;
      const nextData = await apiGet(nextPath);
      if (!nextData || !Array.isArray(nextData.episodes)) break;
      episodes = episodes.concat(nextData.episodes);
      if (!nextData.episode_pagination?.has_more) break;
      offset += nextData.episode_pagination.returned_count || nextData.episodes.length || 48;
      guard++;
    }
  }

  const result = episodes
    .map((ep, i) => ({
      index: i + 1,
      title: String(ep.title || `第${i + 1}集`).trim(),
      token: ep.token || '',
    }))
    .filter(ep => ep.token);

  if (result.length > 0) {
    await setCache(cacheKey, result, 1800);
  }
  return result;
}

export async function resolveStream(token) {
  if (!token) return [];
  const cacheKey = `stream:${token}`;
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  const path = `/v1/playback/resolve/${encodeURIComponent(token)}?view=compact`;
  const data = await apiGet(path);
  if (!data || !Array.isArray(data.line_options)) return [];

  const lines = [];
  const seen = new Set();

  for (const line of data.line_options) {
    if (!line || typeof line !== 'object') continue;
    // 剔除需登录的票据线
    if (line.resolve_required || !line.resolved) continue;
    if (line.url_kind !== 'm3u8' && line.url_kind !== 'mp4') continue;
    const url = String(line.url || '').trim();
    if (!url.startsWith('http')) continue;
    const name = String(line.label || line.play_from || '线路').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    lines.push({
      name,
      playFrom: line.play_from || '',
      url,
    });
  }

  if (lines.length > 0) {
    await setCache(cacheKey, lines, 180);
  }
  return lines;
}

export async function searchVideos(keyword, limit = 20) {
  const cleanKeyword = String(keyword || '').trim();
  if (!cleanKeyword) return [];
  const cacheKey = `search:${cleanKeyword}:${limit}`;
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  const path = `/v1/suggest?q=${encodeURIComponent(cleanKeyword)}&limit=${limit}`;
  const data = await apiGet(path);
  if (!data || !Array.isArray(data.suggestions)) return [];

  const variantIds = [];
  for (const s of data.suggestions) {
    if (s && s.type === 'title' && s.target && s.target.variant_id) {
      const vid = s.target.variant_id;
      if (!variantIds.includes(vid)) variantIds.push(vid);
    }
  }

  const results = [];
  for (const vid of variantIds.slice(0, 12)) {
    const detail = await fetchDetail(vid);
    if (detail) {
      results.push({
        vodId: detail.vodId,
        vodName: detail.vodName,
        vodPic: detail.vodPic,
        vodYear: detail.vodYear,
        vodRemarks: detail.vodRemarks,
        totalEpisodeCount: detail.totalEpisodeCount,
      });
    }
  }

  await setCache(cacheKey, results, 600);
  return results;
}