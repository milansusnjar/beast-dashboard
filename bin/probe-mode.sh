#!/usr/bin/env bash
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DROPIN_DIR="$HOME/.config/systemd/user/beast-dash.service.d"
DROPIN="$DROPIN_DIR/probe.conf"
BIN="$REPO/probe/target/release/beast-probe"
PORT=8787
command -v node >/dev/null && PORT="$(node -p 'try { require(process.argv[1]).port || 8787 } catch { 8787 }' "$REPO/state/settings.json")"

status() {
  if [ -f "$DROPIN" ]; then echo "configured: node (BD_PROBE=node in $DROPIN)"; else echo "configured: rust"; fi
  [ -x "$BIN" ] && echo "binary:     $BIN" || echo "binary:     missing — run: $0 build"
  command -v node >/dev/null || { echo "running:    unknown (node not on PATH)"; return; }
  echo "running:    $(curl -s -m 5 http://127.0.0.1:$PORT/api/state | node -e 'try { const p = JSON.parse(require("fs").readFileSync(0, "utf8")).host.probe; console.log(p.mode + (p.reason ? " (" + p.reason + ")" : "") + (p.lastError ? ", last error: " + p.lastError : "")) } catch { console.log("unknown (dashboard not answering)") }')"
}
restart() {
  systemctl --user daemon-reload
  systemctl --user restart beast-dash
  for _ in $(seq 1 20); do systemctl --user is-active --quiet beast-dash && curl -sf -m 2 http://127.0.0.1:$PORT/api/version >/dev/null && break; sleep 0.5; done
  systemctl --user is-active beast-dash
  status
}

case "${1:-status}" in
  node) mkdir -p "$DROPIN_DIR"; printf '[Service]\nEnvironment=BD_PROBE=node\n' > "$DROPIN"; restart ;;
  rust) [ -x "$BIN" ] || { echo "no binary at $BIN — run: $0 build" >&2; exit 1; }; rm -f "$DROPIN"; restart ;;
  build) cd "$REPO/probe" && "${CARGO:-$(command -v cargo || echo "$HOME/.cargo/bin/cargo")}" build --release && "$BIN" --once >/dev/null && echo "built $BIN — a running dashboard picks it up after: $0 rust" ;;
  status) status ;;
  *) echo "usage: $0 [status|node|rust|build]" >&2; exit 2 ;;
esac
