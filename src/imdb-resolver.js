/**
 * IMDb → 懂片帝 vodId 解析
 *
 * 策略（与 jpyy 一致）：
 *   1. 从 TMDB 拿元数据：title / original_title / year / season_count
 *   2. 从 TMDB 拿全部别名（alternative_titles）
 *   3. 收集候选标题，中文优先排序
 *   4. 用每个候选标题调懂片帝 /v1/browse/catalog?query_mode=fast_v3（带 kind 过滤）
 *   5. 匹配：
 *      - 剧集：先按标题里的"第X季"匹配 season
 *      - 兜底：计算与所有候选标题的最高相似度 + 年份加分
 *   6. 阈值 0.5，写入缓存 7 天
 *
 * @module imdb-resolver
 */

import { CONFIG } from './config.js';
import { fetchImdbMeta, fetchAlternativeTitles } from './tmdb.js';
import { searchVideos } from './adapter.js';
import { getCache, setCache } from './cache.js';
import { createLogger } from './logger.js';
import { similarity, extractSeasonNumber } from './helper.js';

const log = createLogger('IMDbResolve');

/** 缓存 TTL：7 天 */
const CACHE_TTL = 7 * 24 * 60 * 60;

/** 最多搜索的候选标题数（避免请求过多） */
const MAX_SEARCH_TITLES = 5;

// ==========================================
// 主入口
// ==========================================

/**
 * 把 IMDb ID 解析为懂片帝 vodId
 *
 * @param {string} imdbId - 形如 'tt0109830'
 * @param {string} type - 'movie' 或 'series'
 * @param {number} season - 季数（剧集用，默认 1）
 * @returns {Promise<{vodId: string, title: string, year: number|null, kind: string, tmdbId: number|null} | null>}
 */
export async function resolveImdbToVod(imdbId, type, season = 1) {
  log.info(`resolve: ${imdbId} type=${type} season=${season}`);

  // ===== 1. 缓存 =====
  const cacheKey = `imdb2vod:${imdbId}:${type}:${season}`;
  const cached = await getCache(cacheKey);
  if (cached) {
    log.info(`缓存命中: ${imdbId} → vodId=${cached.vodId}`);
    return cached;
  }

  // ===== 2. TMDB 元数据 =====
  const meta = await fetchImdbMeta(imdbId, type);
  if (!meta || !meta.title) {
    log.warn(`无元数据: ${imdbId}`);
    return null;
  }

  // ===== 3. 收集候选标题 =====
  const candidateTitles = await collectCandidates(meta, type);
  if (candidateTitles.length === 0) {
    log.warn('无候选标题');
    return null;
  }

  // ===== 4. 多标题搜索 =====
  // 懂片帝的 kind 值域与 catalog 一致，用 kind 过滤能显著提高匹配精度
  const kind = type === 'movie' ? 'movie' : '';
  const { results, searchedTitles } = await searchWithCandidates(candidateTitles, kind);

  if (results.length === 0) {
    log.warn(`搜索无结果: ${searchedTitles.join(' | ')}`);
    return null;
  }

  log.info(`候选数: ${results.length}，搜索过 ${searchedTitles.length} 个标题`);

  // ===== 5. 匹配 =====
  let matched = null;

  // 剧集且元数据有季数：先按 season 匹配
  if (type === 'series' && meta.seasonCount > 0) {
    matched = findSeasonMatch(results, season, candidateTitles);
    if (matched) log.info(`season ${season} 命中: "${matched.vodName}"`);
  }

  // 兜底：最佳相似度匹配
  if (!matched) {
    matched = findBestMatch(results, candidateTitles, meta.year);
    if (matched) log.info(`最佳匹配: "${matched.vodName}"`);
  }

  if (!matched) {
    log.warn(`无匹配项: "${meta.title}"`);
    return null;
  }

  // ===== 6. 写缓存 =====
  const result = {
    vodId: matched.vodId,
    title: matched.vodName,
    year: matched.vodYear || null,
    kind: matched.kind || '',
    tmdbId: meta.tmdbId || null,
  };
  await setCache(cacheKey, result, CACHE_TTL);
  log.info(`解析成功并缓存: ${imdbId} → vodId=${result.vodId}`);
  return result;
}

// ==========================================
// 候选标题
// ==========================================

async function collectCandidates(meta, type) {
  const set = new Set();

  if (meta.title) set.add(meta.title.trim());
  if (meta.originalTitle && meta.originalTitle !== meta.title) {
    set.add(meta.originalTitle.trim());
  }

  if (meta.tmdbId) {
    try {
      const alts = await fetchAlternativeTitles(meta.tmdbId, type);
      for (const a of alts) if (a) set.add(a.trim());
    } catch (err) {
      log.warn(`别名拉取失败: ${err.message}`);
    }
  }

  // 中文优先
  const sorted = [...set].sort((a, b) => titlePriority(b) - titlePriority(a));
  const limited = sorted.slice(0, MAX_SEARCH_TITLES);

  log.debug(`候选标题: ${limited.join(' | ')}`);
  return limited;
}

/**
 * 3 = 纯中文；2 = 中文占比 > 50%；0 = 其他
 */
function titlePriority(title) {
  if (!title) return -1;
  if (/^[\u4e00-\u9fa5]+$/.test(title)) return 3;
  const cn = (title.match(/[\u4e00-\u9fa5]/g) || []).length;
  if (cn / title.length > 0.5) return 2;
  return 0;
}

// ==========================================
// 多标题搜索
// ==========================================

/**
 * 用多个候选标题搜索站点，并过滤噪音
 *
 * 过滤策略：每个搜索结果与所有候选标题计算相似度，取最大值。
 * 最大值低于 SIM_THRESHOLD 视为噪音，丢弃。
 *
 * 效果（实测）：
 *   "阿甘正传" 5 个候选 → 40 条原始 → ~5 条保留
 *   "三体" 5 个候选 → 65 条原始 → ~15 条保留
 *
 * @param {string[]} candidates - 候选标题（按优先级排序）
 * @param {string} kind - 懂片帝 kind（'' 表示不过滤类型）
 */
async function searchWithCandidates(candidates, kind) {
  const SIM_THRESHOLD = 0.35;

  const allResults = [];
  const seenIds = new Set();
  const searched = [];

  let rawCount = 0;
  let keptCount = 0;

  for (const kw of candidates) {
    if (!kw || kw.length < 2) continue;
    try {
      const results = await searchVideos(kw, kind, 1);
      searched.push(kw);

      if (!Array.isArray(results) || results.length === 0) {
        log.debug(`  "${kw}" → 0 条`);
        continue;
      }

      rawCount += results.length;
      let kept = 0;

      for (const r of results) {
        if (!r.vodId || seenIds.has(r.vodId)) continue;

        // 计算与所有候选标题的最大相似度
        let maxSim = 0;
        for (const c of candidates) {
          const sim = similarity(c, r.vodName);
          if (sim > maxSim) maxSim = sim;
        }

        if (maxSim < SIM_THRESHOLD) continue;  // 噪音过滤

        seenIds.add(r.vodId);
        allResults.push(r);
        kept++;
        keptCount++;
      }

      log.debug(`  "${kw}" → ${results.length} 条，保留 ${kept} 条`);
    } catch (err) {
      log.warn(`  "${kw}" 搜索失败: ${err.message}`);
    }
  }

  log.info(`搜索合并：原始 ${rawCount} 条 → 过滤后 ${keptCount} 条`);
  return { results: allResults, searchedTitles: searched };
}

// ==========================================
// 匹配逻辑
// ==========================================

function findSeasonMatch(results, targetSeason, candidates) {
  const withSeason = [];

  for (const r of results) {
    const sn = extractSeasonNumber(r.vodName);
    if (sn === null) continue;

    const maxSim = Math.max(...candidates.map(t => similarity(t, r.vodName)));
    if (maxSim > 0.3) {
      withSeason.push({ ...r, season: sn, similarity: maxSim });
    }
  }

  if (withSeason.length === 0) return null;

  const exact = withSeason.find(c => c.season === targetSeason);
  if (exact) return exact;

  withSeason.sort((a, b) => b.similarity - a.similarity);
  log.debug(`season ${targetSeason} 无精确匹配，用最高相似度`);
  return withSeason[0];
}

function findBestMatch(results, candidates, targetYear) {
  let best = null;
  let bestScore = 0;

  for (const r of results) {
    let maxSim = 0;
    let matchedTitle = '';
    for (const t of candidates) {
      const sim = similarity(t, r.vodName);
      if (sim > maxSim) {
        maxSim = sim;
        matchedTitle = t;
      }
    }

    let yearBonus = 0;
    const rYear = parseInt(r.vodYear, 10);
    if (targetYear && rYear) {
      const diff = Math.abs(targetYear - rYear);
      if (diff === 0) yearBonus = 0.3;
      else if (diff === 1) yearBonus = 0.15;
      else if (diff > 3) yearBonus = -0.3;
    }

    let exactBonus = 0;
    for (const t of candidates) {
      if (r.vodName === t) { exactBonus = 0.5; break; }
      if (r.vodName.includes(t) || t.includes(r.vodName)) {
        exactBonus = Math.max(exactBonus, 0.2);
      }
    }

    const score = maxSim + yearBonus + exactBonus;

    if (score > 0.3) {
      log.debug(`  "${r.vodName}" (${r.vodYear || '?'}) 匹配="${matchedTitle}" sim=${maxSim.toFixed(2)} score=${score.toFixed(2)}`);
    }

    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }

  if (best && bestScore >= CONFIG.MATCH_THRESHOLD) {
    log.debug(`winner: "${best.vodName}" score=${bestScore.toFixed(2)}`);
    return best;
  }

  log.debug(`无匹配高于阈值 (${CONFIG.MATCH_THRESHOLD})`);
  return null;
}