/**
 * 统一日志系统
 *
 * 特性：
 *   - 分级：debug(10) / info(20) / warn(30) / error(40) / silent(100)
 *   - 模块前缀：createLogger('Adapter') → [Adapter] ...
 *   - 时间戳：HH:MM:SS.mmm
 *   - 动态级别：URL 参数 ?debug=1 提升为 debug 级别（单次请求）
 *   - 环境变量：LOG_LEVEL=debug|info|warn|error|silent
 *
 * 使用：
 *   import { createLogger } from './logger.js';
 *   const log = createLogger('Adapter');
 *   log.debug('fetchCatalog', { catalogId, skip });
 *   log.info('catalog ok', metas.length);
 *   log.warn('cache miss');
 *   log.error('failed', err.message);
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const envLevel = (typeof process !== 'undefined' && process.env?.LOG_LEVEL) || 'info';
let defaultLevel = LEVELS[envLevel] !== undefined ? LEVELS[envLevel] : LEVELS.info;

/** 每个请求作用域可临时覆盖 */
let requestLevel = null;

export function setLogLevel(level) {
  if (typeof level === 'number') { requestLevel = level; return; }
  if (LEVELS[level] !== undefined) requestLevel = LEVELS[level];
}

export function resetLogLevel() { requestLevel = null; }

export function getLogLevel() {
  return requestLevel !== null ? requestLevel : defaultLevel;
}

function ts() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

const CN = {
  debug: '🐛',
  info: 'ℹ️',
  warn: '⚠️',
  error: '❌',
};

function emit(level, module, msg, args) {
  if (LEVELS[level] < getLogLevel()) return;
  const prefix = `[${ts()}] ${CN[level]} [${module}]`;
  const fn = level === 'error' ? console.error
           : level === 'warn'  ? console.warn
           : console.log;
  if (args.length > 0) fn(prefix, msg, ...args);
  else fn(prefix, msg);
}

export function createLogger(module) {
  return {
    debug: (msg, ...args) => emit('debug', module, msg, args),
    info:  (msg, ...args) => emit('info',  module, msg, args),
    warn:  (msg, ...args) => emit('warn',  module, msg, args),
    error: (msg, ...args) => emit('error', module, msg, args),
    /** 计时器：const t = log.timer(); t('label') → 打印耗时 */
    timer: () => {
      const start = Date.now();
      return (label) => {
        const ms = Date.now() - start;
        emit('debug', module, `${label} (${ms}ms)`);
        return ms;
      };
    },
  };
}