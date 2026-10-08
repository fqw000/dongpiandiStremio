if (!globalThis.__logPatched) {
  globalThis.__logPatched = true;
  const _log = console.log.bind(console);
  const _warn = console.warn.bind(console);
  const _error = console.error.bind(console);
  const ts = () => {
    const d = new Date();
    return `[${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}]`;
  };
  console.log = (...a) => _log(ts(), ...a);
  console.warn = (...a) => _warn(ts(), ...a);
  console.error = (...a) => _error(ts(), ...a);
}

export const config = { runtime: 'edge' };

import handler from '../src/handler.js';

export default async function vercelHandler(request) {
  return await handler.fetch(request, process.env, null);
}