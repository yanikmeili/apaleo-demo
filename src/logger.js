// Minimal structured logger. Never log tokens, secrets or guest personal data.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const current = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

function emit(level, msg, meta) {
  if (LEVELS[level] < current) return;
  const line = { ts: new Date().toISOString(), level, msg, ...(meta || {}) };
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(JSON.stringify(line));
}

export const log = {
  debug: (msg, meta) => emit('debug', msg, meta),
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
};
