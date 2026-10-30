# How it fits together

```
server.js            HTTP + SSE API, one tick loop (fast while someone is watching, slow when not)
lib/discovery.js     scans devRoot, classifies projects, finds their commands
lib/runtime.js       processes, ports, tmux sessions, containers — attributed to projects
lib/probe.js         process table, ports and GPU from probe/ (Rust, no crates), Node fallback
lib/detach.js        moves tmux/socat/adb into their own systemd scopes, so they outlive the service
lib/actions.js       start/stop/restart in tmux, Claude sessions, shells
lib/claude.js        session state from hooks; restore after reboot
lib/usage.js         transcript cost        lib/limits.js   plan limits
lib/schedule.js      timed prompts          lib/tasks.js    task backlog
lib/gitinfo.js       git status/diffs       lib/files.js    file tree / editor
lib/expose.js        socat forwards         lib/push.js     Web Push (VAPID + aes128gcm, no deps)
lib/health.js        port health            lib/sys.js      system stats (temps kept 30 days, /api/temps?days=N)
lib/recap.js         per-day recap from git log + transcripts
lib/plans.js         docs/<topic>/PLAN + PROGRESS   lib/worktrees.js  git worktrees (local only)
lib/subagents.js     subagent transcripts           lib/emulator.js   adb + emulator
public/              the UI — vanilla JS: app.js + feature modules f-*.js / f-*.css (hooks via feat())
term/                ttyd's page + the phone layer (build with bin/build-term-index.sh)
bin/                 hook script + installer, HTTPS setup, terminal entrypoint, icon generator,
                     gate.sh (boots an isolated copy, checks every route and the guards)
```

The dashboard never runs a command in its own process: everything goes through
`tmux new-session … bash -ic`, so `nvm`, `.bashrc` and your environment are exactly what a manual
terminal would have, and it all keeps running if the dashboard restarts.
