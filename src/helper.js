/**
 * 工具函数
 */

import { createLogger } from './logger.js';
const log = createLogger('Helper');

/** UUID v4 */
export function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** base64url 解码为 UTF-8 字符串（Edge Runtime 兼容） */
export function decodeBase64Url(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  if (typeof atob === 'function') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }
  return Buffer.from(base64, 'base64').toString('utf-8');
}

/** base64url 编码（UTF-8 → base64url） */
export function encodeBase64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = btoa(binary);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** 清理 HTML 标签与实体 */
export function cleanHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** 计算字符串相似度（Levenshtein 归一化） */
export function similarity(s1, s2) {
  if (!s1 || !s2) return 0;
  s1 = String(s1).toLowerCase().trim();
  s2 = String(s2).toLowerCase().trim();
  if (s1 === s2) return 1.0;
  if (s1.includes(s2) || s2.includes(s1)) return 0.85;

  let [a, b] = [s1, s2];
  if (a.length < b.length) [a, b] = [b, a];
  const lenA = a.length, lenB = b.length;
  if (lenA === 0 || lenB === 0) return 0;

  let prev = new Array(lenB + 1);
  let curr = new Array(lenB + 1);
  for (let j = 0; j <= lenB; j++) prev[j] = j;
  for (let i = 1; i <= lenA; i++) {
    curr[0] = i;
    for (let j = 1; j <= lenB; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return 1 - prev[lenB] / Math.max(lenA, lenB);
}

/** 从标题提取季数（"第三季" / "第3季" / "Season 3" / "S3"） */
const CN_NUM = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
export function extractSeasonNumber(title) {
  if (!title) return null;
  const cn = String(title).match(/第([一二三四五六七八九十])季/);
  if (cn) return CN_NUM[cn[1]] || null;
  const num = String(title).match(/第\s*(\d+)\s*季/);
  if (num) return parseInt(num[1], 10);
  const en = String(title).match(/season\s*(\d+)/i);
  if (en) return parseInt(en[1], 10);
  const s = String(title).match(/\bS(\d+)\b/);
  if (s) {
    const n = parseInt(s[1], 10);
    if (n < 100) return n;
  }
  return null;
}

/** 从集名提取集数（"第1集" / "1" / "EP01"） */
export function extractEpisodeNumber(name) {
  if (!name) return NaN;
  const m = String(name).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : NaN;
}