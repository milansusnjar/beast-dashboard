const WINDOW = { permission: 5000, error: 30000, limit: 30000, done: 30000 };

function createPushGate(window = WINDOW) {
  const last = new Map();
  return {
    blocked(tmux, kind, now) { const t = last.get(tmux + '|' + kind); return t != null && now - t < (window[kind] ?? 30000); },
    sent(tmux, kind, now) { last.set(tmux + '|' + kind, now); },
  };
}

module.exports = { createPushGate, WINDOW };
