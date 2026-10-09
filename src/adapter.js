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

import { apiGet, apiPost } from './http.js';
import { getCache, setCache } from './cache.js';
import { CONFIG } from './config.js';
import { createLogger } from './logger.js';
const log = createLogger('Adapter');

const PAGE_LIMIT = 20;

export const CATALOG_MAP = {
  'dpd-movie': { kind: 'movie', stremioType: 'movie' },
  'dpd-series': { kind: 'series', stremioType: 'series' },
  'dpd-short': { kind: 'short_drama', stremioType: 'series' },
  'dpd-anime': { kind: 'anime', stremioType: 'series' },
  'dpd-variety': { kind: 'variety', stremioType: 'series' },
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
    log.info(` ✅ Catalog 缓存命中: ${cacheKey} (${cached.length} 条)`);
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
    log.info(` ✅ Episodes 缓存命中: ${vodId} (${cached.length} 集)`);
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


/**
 * 解析单条 resolve:// 票据
 *
 * 懂片帝的官方高清线路以 resolve://<ticket> 形式下发，
 * 需带登录 Cookie 二次 POST /v1/playback/resolve-line 换取真实直链。
 *
 * 返回值可能是 mp4（字节 CDN）或 m3u8，具体由响应中的 url_kind 决定。
 * 本函数不依赖 url_kind 字段值，只校验 url 是否为 http 开头。
 *
 * @param {Object} line - 原始 line_option
 * @param {string} cookie - 用户登录 Cookie
 * @returns {Promise<Object|null>} - 成功返回 { name, playFrom, url, weight, isDefault }，失败返回 null
 */
async function resolveTicketLine(line, cookie) {
  const rawUrl = String(line.url || '');
  if (!rawUrl.startsWith('resolve://')) {
    return null;
  }

  const ticket = rawUrl.slice('resolve://'.length).trim();
  if (!ticket) return null;

  const label = line.label || line.play_from || '官方线路';

  try {
    // 兼容用户两种粘贴方式：
    //   - 只粘贴 Cookie 值（ums2_...），自动补 ai_movie_session=
    //   - 粘贴完整 Cookie 头（ai_movie_session=ums2_...），原样使用
    const cookieHeader = cookie.includes('ai_movie_session=')
      ? cookie
      : `ai_movie_session=${cookie}`;

    const resp = await apiPost(
      '/v1/playback/resolve-line?view=compact',
      { ticket },
      { cookie: cookieHeader }
    );

    if (!resp || !resp.line || !resp.line.url) {
      log.debug(`票据解析无有效 url: ${label}`);
      return null;
    }

    const url = String(resp.line.url).trim();
    if (!url.startsWith('http')) {
      log.debug(`票据解析返回非 http url: ${url.slice(0, 40)}`);
      return null;
    }

    return {
      name: String(resp.line.label || label).trim(),
      playFrom: resp.line.play_from || line.play_from || '',
      url,
      weight: resp.line.preference_weight || line.preference_weight || 0,
      isDefault: resp.line.default_priority === true || line.default_priority === true,
    };
  } catch (err) {
    // 区分失败原因：402=需付费会员，404=票据失效/无权限，429=限流
    const msg = err.message || '';
    let reason = msg;
    if (msg.includes('402')) reason = '需付费会员';
    else if (msg.includes('404')) reason = '线路不可用';
    else if (msg.includes('429')) reason = '站点限流';
    else if (msg.includes('401')) reason = '登录态失效';
    log.debug(`票据解析失败 (${label}): ${reason}`);
    return null;
  }
}


/**
 * 解析播放线路
 *
 * 缓存优先级（从上到下，命中即返回，避免多余 HTTP）：
 *   1. official 缓存（有 Cookie 且官方线路成功过）
 *   2. negative 缓存（有 Cookie 但官方线路 5 分钟内失败过）→ 关闭官方分支
 *   3. direct 缓存（m3u8 直连线路）
 *   4. 缓存全 miss → 调 resolve 拿线路列表
 *   5. 有 Cookie → 尝试解析官方线路；失败/无 ticket → 回退到第 6 步
 *   6. 直连 m3u8/mp4 分支（不论 Cookie 状态）
 *
 * @param {string} token - episode token
 * @returns {Promise<Array<{name, playFrom, url, weight, isDefault}>>}
 */
export async function resolveStream(token) {
  if (!token) return [];

  const cookie = CONFIG.SESSION_COOKIE || '';
  let hasCookie = !!cookie;
  const cookieTag = hasCookie ? await shortHash(cookie) : 'anon';

  const officialCacheKey = hasCookie ? `stream:${token}:${cookieTag}:official` : null;
  const negativeCacheKey = hasCookie ? `stream:${token}:${cookieTag}:official:negative` : null;
  const directCacheKey = `stream:${token}:${cookieTag}:direct`;

  // ===== 1-2. 有 Cookie：查 official 缓存 + negative 缓存 =====
  if (hasCookie) {
    const cached = await getCache(officialCacheKey);
    if (cached && cached.length > 0) {
      log.debug(`official 缓存命中: ${token.slice(0, 20)}...`);
      return cached;
    }

    const negative = await getCache(negativeCacheKey);
    if (negative) {
      log.info(`negative 缓存命中，跳过票据解析`);
      hasCookie = false;
    }
  }

  // ===== 3. 查 direct 缓存（提前到 resolve 之前）=====
  const directCached = await getCache(directCacheKey);
  if (directCached && directCached.length > 0) {
    log.debug(`direct 缓存命中: ${token.slice(0, 20)}...`);
    return directCached;
  }

  // ===== 4. 缓存全 miss，调 resolve 拉线路列表 =====
  const path = `/v1/playback/resolve/${encodeURIComponent(token)}?view=compact`;
  const data = await apiGet(path);
  if (!data || !Array.isArray(data.line_options)) return [];

  // ===== 5. 有 Cookie：尝试解析官方线路 =====
  // 注意：官方线路失败 → 只写 negative 缓存，不 return。
  // 控制流继续往下到第 6 步的直连分支。
  if (hasCookie) {
    const ticketLines = data.line_options.filter(l =>
      l && l.url_kind === 'resolve_ticket' && String(l.url || '').startsWith('resolve://')
    );

    if (ticketLines.length > 0) {
      // 请求前黑名单过滤
      const blockedSet = new Set(CONFIG.BLOCKED_LINES || []);
      const ticketLinesFiltered = ticketLines.filter(l => {
        const label = String(l.label || l.play_from || '').trim();
        if (blockedSet.has(label)) {
          log.debug(`黑名单跳过官方线路: ${label}`);
          return false;
        }
        return true;
      });

      const skippedByBlocklist = ticketLines.length - ticketLinesFiltered.length;
      if (skippedByBlocklist > 0) {
        log.info(`黑名单过滤: ${ticketLines.length} → ${ticketLinesFiltered.length} 条（省 ${skippedByBlocklist} 次请求）`);
      }

      if (ticketLinesFiltered.length > 0) {
        log.info(`解析 ${ticketLinesFiltered.length} 条票据线路（已配置 Cookie）`);

        const resolved = [];
        for (const l of ticketLinesFiltered) {
          const r = await resolveTicketLine(l, cookie).catch(() => null);
          if (r) resolved.push(r);
          // 站点对 resolve-line 有 QPS 限流，串行 + 250ms 间隔
          await new Promise(resolve => setTimeout(resolve, 250));
        }

        if (resolved.length > 0) {
          resolved.sort((a, b) => {
            if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
            return (b.weight || 0) - (a.weight || 0);
          });
          log.info(`票据解析成功 ${resolved.length}/${ticketLinesFiltered.length}，使用官方线路`);
          await setCache(officialCacheKey, resolved, 180);
          return resolved;
        }

        // 官方全失败：写 negative，继续走直连
        log.warn(`票据解析全部失败（0/${ticketLinesFiltered.length}），回退到直连 m3u8`);
        await setCache(negativeCacheKey, { ts: Date.now() }, 300);
      } else {
        // 全部被黑名单过滤，也视为官方不可用
        log.warn(`官方线路全被黑名单过滤（${ticketLines.length} 条全命中）`);
        await setCache(negativeCacheKey, { ts: Date.now() }, 300);
      }
    } else {
      log.info(`该集无 resolve_ticket 线路，回退到直连 m3u8`);
    }
  }
  // ↑ 到这里，if (hasCookie) 块结束。
  //   控制流无条件继续到下面的第 6 步。

  // ===== 6. 直连 m3u8/mp4 分支（不论 Cookie 状态都执行）=====
  const direct = data.line_options.filter(l =>
    l &&
    l.resolved === true &&
    !l.resolve_required &&
    (l.url_kind === 'm3u8' || l.url_kind === 'mp4') &&
    String(l.url || '').startsWith('http')
  );

  direct.sort((a, b) => {
    if (a.default_priority !== b.default_priority) return a.default_priority ? -1 : 1;
    if (a.selected !== b.selected) return a.selected ? -1 : 1;
    return (b.preference_weight || 0) - (a.preference_weight || 0);
  });

  const blocked = new Set(CONFIG.BLOCKED_LINES || []);
  const seen = new Set();
  const lines = [];
  for (const l of direct) {
    const name = String(l.label || l.play_from || '线路').trim();
    if (!name || seen.has(name)) continue;
    if (blocked.has(name)) {
      log.debug(`跳过黑名单直连线路: ${name}`);
      continue;
    }
    seen.add(name);
    lines.push({
      name,
      playFrom: l.play_from || '',
      url: l.url,
      weight: l.preference_weight || 0,
      isDefault: l.default_priority === true,
    });
  }

  if (blocked.size > 0) {
    log.info(`黑名单生效，过滤后 ${lines.length} 条线路（黑名单 ${blocked.size} 项）`);
  }

  const modeLabel = CONFIG.SESSION_COOKIE ? 'Cookie·回退' : '匿名';
  log.info(`${modeLabel}模式：返回 ${lines.length} 条直连线路`);

  if (lines.length > 0) {
    await setCache(directCacheKey, lines, 180);
  }
  return lines;
}

  /**
   * Cookie 短 hash（用于缓存 key 隔离，不泄露 Cookie 原文）
   */
  async function shortHash(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 8);
  }


  // /**
  //  * 搜索影片
  //  *
  //  * 懂片帝 /v1/suggest 返回的每条 suggestion 带 plan.kind，
  //  * 明确标识该结果是 movie / series / short_drama / anime / variety / documentary。
  //  * 这是判断影片类型的权威来源，不要用 detail 的 total_episode_count（电影也会返回 1）。
  //  *
  //  * @param {string} keyword - 搜索关键词
  //  * @param {number} limit - 返回条数上限（默认 20）
  //  * @returns {Promise<Array<{
  //  *   vodId: string,
  //  *   vodName: string,
  //  *   vodPic: string,
  //  *   vodYear: string,
  //  *   vodRemarks: string,
  //  *   kind: string,        // 懂片帝原始 kind，如 'movie' / 'series'
  //  *   isMovie: boolean,    // 派生字段，便于 handler 过滤
  //  * }>>}
  //  */
  // export async function searchVideos(keyword, limit = 20) {
  //   const cleanKeyword = String(keyword || '').trim();
  //   if (!cleanKeyword) {
  //     log.warn(' searchVideos: 空关键词');
  //     return [];
  //   }

  //   const cacheKey = `search:${cleanKeyword}:${limit}`;
  //   const cached = await getCache(cacheKey);
  //   if (cached) {
  //     log.info(` searchVideos 缓存命中: "${cleanKeyword}" → ${cached.length} 条`);
  //     return cached;
  //   }

  //   const path = `/v1/suggest?q=${encodeURIComponent(cleanKeyword)}&limit=${limit}`;
  //   log.info(` searchVideos 请求: ${path}`);
  //   const data = await apiGet(path);

  //   if (!data || !Array.isArray(data.suggestions)) {
  //     log.debug(' searchVideos: suggestions 不是数组');
  //     return [];
  //   }

  //   // ===== 1. 从 suggest 提取 variantId + kind =====
  //   // kind 是权威类型标识，直接来自懂片帝的 plan.kind
  //   const suggestions = [];
  //   const seen = new Set();
  //   for (const s of data.suggestions) {
  //     if (!s || s.type !== 'title') continue;
  //     const vid = s.target && s.target.variant_id;
  //     if (!vid || seen.has(vid)) continue;
  //     seen.add(vid);
  //     suggestions.push({
  //       variantId: vid,
  //       kind: (s.plan && s.plan.kind) || '',
  //       label: s.label || '',
  //     });
  //   }
  //   log.debug(` searchVideos: 提取 ${suggestions.length} 个 variantId`);

  //   if (suggestions.length === 0) {
  //     await setCache(cacheKey, [], 600);
  //     return [];
  //   }

  //   // ===== 2. 并发补详情（最多 12 条）=====
  //   // 并发能显著降低搜索整体耗时；单条失败不影响其他
  //   const targets = suggestions.slice(0, 12);
  //   const detailResults = await Promise.all(
  //     targets.map(s => fetchDetail(s.variantId).catch(err => {
  //       console.warn(` searchVideos 详情失败 ${s.variantId}: ${err.message}`);
  //       return null;
  //     }))
  //   );

  //   // ===== 3. 组装结果 =====
  //   const results = [];
  //   for (let i = 0; i < targets.length; i++) {
  //     const s = targets[i];
  //     const detail = detailResults[i];
  //     if (!detail) continue;
  //     results.push({
  //       vodId: detail.vodId,
  //       vodName: detail.vodName,
  //       vodPic: detail.vodPic,
  //       vodYear: detail.vodYear,
  //       vodRemarks: detail.vodRemarks,
  //       kind: s.kind,                    // 权威类型
  //       isMovie: s.kind === 'movie',      // 派生字段
  //     });
  //   }

  //   await setCache(cacheKey, results, 600);
  //   log.info(` searchVideos: 返回 ${results.length} 条`);
  //   return results;
  // }


  /**
   * 搜索影片
   *
   * 懂片帝支持 /v1/browse/catalog 直接搜索（query_mode=fast_v3），
   * 一步返回完整 cards[]，无需再补 detail。相比 /v1/suggest + N 次 detail，
   * 请求数从 N+1 降到 1。
   *
   * 接口（探针实测 2026-10-09）：
   *   GET /v1/browse/catalog?query_mode=fast_v3&search_fields=all&q=<kw>&kind=<k>&page=<p>&limit=20
   *   - kind 可选：不传返回全部类型；传 kind=movie 只返回电影
   *   - 返回的 cards[] 结构与 catalog 浏览完全一致
   *
   * @param {string} keyword - 搜索关键词
   * @param {string} kind - 懂片帝 kind（'movie' / 'series' / 'short_drama' / 'anime' / 'variety' / 'documentary'），
   *                        空字符串表示不过滤类型
   * @param {number} page - 页码，从 1 开始
   * @returns {Promise<Array<{
   *   vodId: string,
   *   vodName: string,
   *   vodPic: string,
   *   vodYear: string,
   *   vodArea: string,
   *   vodRemarks: string,
   *   kind: string,       // 懂片帝 content_kind
   *   isMovie: boolean,   // kind === 'movie'
   * }>>}
   */

  export async function searchVideos(keyword, kind = '', page = 1) {
    const cleanKeyword = String(keyword || '').trim();
    if (!cleanKeyword) {
      log.warn('searchVideos: 空关键词');
      return [];
    }

    const cacheKey = `search:${cleanKeyword}:${kind || 'all'}:${page}`;
    const cached = await getCache(cacheKey);
    if (cached) {
      log.debug(`searchVideos 缓存命中: "${cleanKeyword}" kind=${kind || 'all'} → ${cached.length} 条`);
      return cached;
    }

    const params = new URLSearchParams({
      query_mode: 'fast_v3',
      search_fields: 'all',
      q: cleanKeyword,
      page: String(page),
      limit: '20',
    });
    if (kind) params.set('kind', kind);

    const path = '/v1/browse/catalog?' + params.toString();
    log.info(`searchVideos: "${cleanKeyword}" kind=${kind || 'all'} page=${page}`);

    const data = await apiGet(path);
    if (!data || !Array.isArray(data.cards)) {
      log.warn('searchVideos: cards 非数组');
      return [];
    }

    const results = data.cards
      .map(card => {
        const vodId = extractVodId(card.detail_url || card.id);
        if (!vodId || !card.title) return null;
        const k = card.content_kind || '';
        return {
          vodId,
          vodName: card.title,
          vodPic: card.poster_url || '',
          vodYear: String(card.year || ''),
          vodArea: card.area || '',
          vodRemarks: card.remarks || '',
          kind: k,
          isMovie: k === 'movie',
        };
      })
      .filter(Boolean);

    await setCache(cacheKey, results, 600);
    log.info(`searchVideos: 返回 ${results.length} 条`);
    return results;
  }

