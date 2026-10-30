# Chat-only Claude sessions (tmux cleanup)

Goal: Claude sessions are chat sessions only. The terminal-bound Claude flow (Claude Code running interactively in a tmux pane that the dashboard scrapes and types into) goes away, together with every UI piece that only exists for it. Ships in the next release.

## What goes
- UI for terminal-bound Claude sessions: the Terminal/Chat switch in the session bar (`chatSw`, `setMode`, `TERM.mode`, `TERM.forceTerm`, `bd.mode`), "Continue in chat" (`switchSession(…, 'chat')`), the `^C` key in the composer, "Hand off" / restart paths that only work on a pane, the old terminal-Claude start path in the new-session modal (Type: Terminal / Session: New / Resume).
- Server code that drives Claude through a pane: pane scraping for state/drafts (`capture-pane` in `lib/claude.js`), `send-keys` prompting (`lib/actions.js`, `server.js`), `cl.draft` / "clear the text typed in the terminal first" checks.
- Anything in `public/f-*.js` that only serves the above (check each `feat()` hook).

## What stays
- Chat sessions (headless runner, transcript, composer, queue, steer, schedule, subagents, files panel, context meter).
- "+ Terminal": a plain tmux shell (`sh-N`) in the browser terminal (ttyd), unchanged.
- "Open this chat in a terminal": a plain shell session that runs `claude --resume <sessionId>` in the session's folder, for the rare case where the TUI is needed. Read-only from the dashboard's point of view (no scraping, no send-keys).
- Runner log view for a chat session (it can move into the Options menu instead of the switch).
- `/api/hook` stays stable (Claude hooks post to it).

## Runners
Chat runners are still started inside tmux (`lib/headless.js`: `new-session` / `respawn-pane`). Move them to `systemd-run --user` transient units (survive dashboard restarts the same way), with a fallback to tmux when systemd user sessions are not available. Keep the runner log reachable (journal or log file).

## Order
1. **Audit (first, no deletions):** list every feature that touches a terminal-bound Claude session and what replaces it in chat. Anything terminal-Claude can do that chat cannot → stop and report before deleting. Write the list into PROGRESS.md.
2. **Frontend removal:** session bar, composer, new-session modal, menus, rail rows. Existing terminal-bound sessions that are still running: show them as plain terminals (no Claude UI) until they end.
3. **Server removal:** scraping, send-keys, draft checks; keep `/api/hook`.
4. **Runners under systemd-run** with tmux fallback.
5. **Tests:** update/remove tests for removed paths; add tests for the systemd-run runner start and the fallback.
6. **Docs:** README text that describes the terminal-bound flow. New screenshots and demo are a separate step after the release.
7. **Review:** fresh reviewer agent on the whole branch, then release.

## Gates
- `node --test test/*.test.js`
- `bin/gate.sh <free port>` (never the live dashboard's port)
- No code comments added (`git diff | grep -E '^\+.*(//|/\*)'` is empty).

## Rules
- Never kill tmux sessions or run `tmux kill-server`; test in a throwaway session on its own socket.
- Keep the security guards in `server.js` and `ttyd -O`.
- Stop and ask before: changing `/api/hook` or any other API contract, touching runtime state formats in `state/`, or if a gate fails twice on the same task.
