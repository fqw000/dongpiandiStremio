/**
 * Vercel Edge Function 入口
 * 日志时间戳由 src/logger.js 统一处理，此处不做 console patch
 */
export const config = { runtime: 'edge' };

import handler from '../src/handler.js';

export default async function vercelHandler(request) {
  return await handler.fetch(request, process.env, null);
}