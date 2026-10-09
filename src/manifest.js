/**
 * Stremio Manifest 动态生成
 */

import { createLogger } from './logger.js';
const log = createLogger('Manifest');

const ALL_CATALOGS = [
  { type: 'movie',  id: 'dpd-movie',       name: '懂片帝 · 电影',   key: 'movie'       },
  { type: 'series', id: 'dpd-series',      name: '懂片帝 · 电视剧', key: 'series'      },
  { type: 'series', id: 'dpd-short',       name: '懂片帝 · 短剧',   key: 'short'       },
  { type: 'series', id: 'dpd-anime',       name: '懂片帝 · 动漫',   key: 'anime'       },
  { type: 'series', id: 'dpd-variety',     name: '懂片帝 · 综艺',   key: 'variety'     },
  { type: 'series', id: 'dpd-documentary', name: '懂片帝 · 纪录片', key: 'documentary' },
];

const GENRE_OPTIONS = {
  movie:       ['剧情', '喜剧', '动作', '爱情', '科幻', '悬疑', '惊悚', '恐怖', '犯罪', '奇幻', '冒险', '战争', '家庭', '古装', '武侠'],
  series:      ['剧情', '爱情', '悬疑', '犯罪', '喜剧', '古装', '动作', '奇幻', '都市', '韩剧', '美剧', '日剧', '欧美剧', '国产剧'],
  short:       ['剧情', '爱情', '古装', '悬疑', '喜剧', '都市'],
  anime:       ['国产动漫', '日韩动漫', '日本动漫', '动作', '奇幻', '冒险', '剧情', '喜剧', '热血', '科幻', '恋爱', '悬疑'],
  variety:     ['综艺', '真人秀', '大陆综艺', '日韩综艺', '欧美综艺', '音乐', '脱口秀', '晚会'],
  documentary: ['纪录片', '历史', '自然', '人文', '科技'],
};

const YEAR_OPTIONS = [];
for (let y = 2026; y >= 2015; y--) YEAR_OPTIONS.push(String(y));

/**
 * @param {Object} options
 * @param {string[]} options.enabledCategories - ['movie','series',...]
 * @param {boolean} options.enableStream - 是否启用 stream resource
 */
export function generateManifest(options = {}) {
  const {
    enabledCategories = ['movie', 'series', 'short', 'anime', 'variety', 'documentary'],
    enableStream = true,
  } = options;

  const catalogs = ALL_CATALOGS
    .filter(c => enabledCategories.includes(c.key))
    .map(({ key, ...rest }) => ({
      ...rest,
      extra: [
        { name: 'genre', options: GENRE_OPTIONS[key] || [], isRequired: false },
        { name: 'year',  options: YEAR_OPTIONS,               isRequired: false },
        { name: 'search', isRequired: false },
        { name: 'skip',   isRequired: false },
      ],
    }));

  const resources = ['catalog', 'meta'];
  if (enableStream) resources.push('stream');

  const manifest = {
    id: 'com.dongpiandi.stremio',
    version: '1.0.0',
    name: 'gpd',
    description: '懂片帝影视资源站 · 支持电影、电视剧、短剧、动漫、综艺、纪录片。兼容站内 ID 与 IMDb ID。仅供学习研究使用。',
    logo: 'https://dongpian17.com/favicon.ico',
    resources,
    types: ['movie', 'series'],
    catalogs,
    idPrefixes: ['dpd_', 'tt'],
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
    },
  };

  log.debug('manifest generated', {
    catalogs: catalogs.length,
    resources: resources.join(','),
    idPrefixes: manifest.idPrefixes.join(','),
  });

  return manifest;
}