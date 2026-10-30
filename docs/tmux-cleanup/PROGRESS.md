# Progress: chat-only Claude sessions

- [x] 1. Audit: terminal-bound Claude features and their chat replacement (list below) — open decisions before step 2
- [ ] 2. Frontend removal (entry points done, see below)
- [ ] 3. Server removal
- [ ] 4. Runners under systemd-run (tmux fallback)
- [ ] 5. Tests
- [ ] 6. README text (screenshots and demo come later, separately)
- [ ] 7. Review, then release

## Audit

Done 2026-10-30. Read-only, nothing deleted. Status: **blocked on the open decisions below** (plan: stop and report before deleting).

### Key facts
- Chat and terminal Claude are both `claude-*` tmux sessions; the only difference is `mode:'chat'` on the record in `state/claude-sessions.json` (`claude.markChat`, `isChat` in server.js). Absent `mode` = terminal.
- No state-format change is needed to remove terminal Claude: once nothing can create terminal sessions, every new record is `mode:'chat'`.
- `claude.refreshPeeks` runs `capture-pane` on every Claude session, chat included (`info()` then drops the peek for chat). Pure waste after the cleanup.
- Pane-only fields on `cl` in `claude.info()`: `bg`, `menu`, `status`, `peek`, `draft`, `limitText`, and the `limit` / `background` states.
- Only `test/panestate.test.js` (7 tests on `paneStateOf`) is pane-coupled.

### Items
| # | Feature (terminal Claude) | Where | Chat equivalent | Verdict |
|---|---|---|---|---|
| 1 | Pane scraping: `paneStateOf`, `parseMenu`, `capturePane`, `refreshPeeks` | lib/claude.js; server.js `decorateClaude` | runner snapshot (`liveOf`: pending, working, ctx) | REMOVE (limit: gap A) |
| 2 | Pane fields in `info()` (`if (p)` block) | lib/claude.js | runner snapshot | REMOVE |
| 3 | Typing into the pane: `send`, `pasteText`, `claudeRunning`, `key`, `choose`, `answer` | lib/claude.js; routes `send`, `key`, `choose`, `answer`, `claude-model`, `schedule-now`, `restart` | `headless.send/interrupt/answer/setModel/setEffort` | REMOVE pane branch of each route |
| 4 | Launch: `claudeCmd`, `launchClaude`, `claudeSession` (reuse, `-N`, `--worktree`, `--continue`, `--resume`) | lib/actions.js; route `claude` | `headless.start/startChat/launch` | REMOVE (gaps C, D) |
| 5 | Exit/restart: `exitClaude`, `paneCmd`, terminal branch of `restartClaude` | lib/actions.js; route `claude-restart` | `headless.restart` | REMOVE terminal branch |
| 6 | Restore: terminal branch of `restoreClaude`, `autoRestore` | lib/actions.js; server.js; routes `claude-restore`, `claude-resume` | chat branch → `headless.launch` resume/fork | REMOVE terminal branch (gap F) |
| 7 | Terminal ↔ chat switch: `claude-switch`, `paneInfo`, `resumeHere`, `respawnShell`, auto-demotion when `paneCmd==='claude'` in a chat session | server.js; lib/actions.js | — | REMOVE; "to terminal" → new "Open this chat in a terminal" |
| 8 | Hand off on limit | route `handoff`; app.js ~610 | NONE | gap A |
| 9 | New-terminal modal Type: Terminal / New / Resume last | app.js `newTerminalModal`; f-session.js "Terminal in a project…" | new-chat modal | REMOVE Terminal type; button → `newShell` |
| 10 | `✦ Claude ▾` menu: terminal personal/company, resume last, another instance, worktree | app.js `claudeMenu` | chat items exist | REMOVE terminal items (gaps C, D) |
| 11 | "Start all" bundles start terminal Claude | app.js `startBundle` | NONE | convert to chat start |
| 12 | Terminal/Chat switch `chatSw`, `TERM.mode`, `bd.mode`, `forceTerm`, `chatMode()` | app.js | per-session `TERM.view` (Runner log) | REMOVE global mode, KEEP `TERM.view` |
| 13 | "Continue in chat" for terminal sessions | app.js `switchSession(…,'chat')` | — | REMOVE |
| 14 | Pane permission menu cards `menuCard`/`menuButtons`, `choose` | app.js; f-inbox.js | `askCard` + `hl-answer` | REMOVE |
| 15 | y/n buttons and `^C` in the composer | app.js ~1506-1550 | ask card, interrupt | REMOVE |
| 16 | `restartIdleTerms` + `oldTerms` banner | app.js | `rollChats`, `chatAutoUpgrade` | REMOVE |
| 17 | Context meter "Clear" (`clearSession`) | app.js | New chat here | REMOVE |
| 18 | Terminal `claude-model` (types `/model`, `/effort`) | server.js; app.js `modelPicker` | `setModel`/`setEffort` | REMOVE terminal branch |
| 19 | "Resume in terminal" of a past conversation | app.js `openTranscriptFile`; `claude-resume` w/o mode | "Continue in chat" | REPLACE with "Open in terminal" (plain shell `claude --resume <id>`) |
| 20 | Tasks fall back to terminal Claude | route `task-run`; app.js ~2409 | chat start | use `headless.start` |
| 21 | Scheduler terminal delivery | server.js `runSchedule` | `headless.send` branch | REMOVE branch |
| 22 | Stop (`stop` route) | lib/actions.js | SIGTERM runner | KEEP (C-c branch serves sh-N, bd_) |
| 23 | Mobile key bar (esc, tab, ⇧tab, ⌥↵, ^C, ^A..^Z, copy-mode) | term/mobile.html | — | KEEP (shells, runner log); only ⇧tab/⌥↵ labels are Claude-specific |
| 24 | Plain shells, dev runs, docker, git actions | lib/actions.js | — | KEEP |
| 25 | `/api/extlogs/:pid` | server.js | — | KEEP (not Claude) |
| 26 | `test/panestate.test.js` | test/ | — | REMOVE with `paneStateOf` |

### Gaps (terminal Claude can, chat cannot)
- **A. Usage limit + Hand off.** `limit` state, inbox `limitText`, `limit` push and the Hand off button come only from pane scraping. The runner already records `rate_limit_event` into `S.rate` (bin/headless-runner.js:211) but nothing turns it into a `limit` state.
- **B. Slash commands.** Terminal composer typed any `/command` into Claude. Chat only wires `/compact` (`sendSlash`). Unverified what `claude -p` stream-json does with `/plan`, `/rewind`, `/clear`, `/mcp` etc.
- **C. Plan mode / permission-mode toggle (⇧tab).** Runner always runs `--dangerously-skip-permissions --permission-prompt-tool stdio`; no plan-mode control in chat.
- **D. New session in a worktree** (`claude --worktree <name>`). `headless.start` has no worktree option.
- **E. Resume last in this folder** (`--continue`). Chat can resume a specific session from history, no one-click "last here". Partial.
- **F. Old terminal records in state.** Records without `mode` would no longer auto-restore after reboot. Convert to chat, forget, or leave (state-format question).
- **G. Claude started outside the dashboard** (user runs `claude` in their own `claude-*` tmux): today it gets the Claude UI via scraping + hooks; after the cleanup it shows as a plain terminal (as the plan says). Hooks still reach `/api/hook` and still create records.
- Covered, no gap: permission prompts (ask card), interrupt (`key esc` → `headless.interrupt`), image paste/attach, dashboard checkpoints, `bg` agents (subagents panel; the `background` state becomes unreachable).

### Bug found on the way
- Inbox "Deny + tell Claude…" (public/f-inbox.js:65) sends `key esc`, which for chat is an interrupt, not a deny. Should be `answer` with `choice: 'deny'` + `message` (`hl-answer` supports `message`).

### Shared code (careful)
- `decorateClaude`: pane-only = `refreshPeeks`, the `paneCmd==='claude' && isChat` demotion, and `current==='claude'` in `isClaude`.
- `claude.info()`: pane-only = the `if (p)` block and fields above; keep hooks state, `liveOf` override, mode/title/model/version/effort.
- `claude.onHook` (`/api/hook` contract): only the `mode!=='chat'` guards are mode-dependent; behaviour for chat must not change.
- `runtime.js tmuxSessions()`: `claudeVersion` from /proc only serves terminal "restart to update".
- `STATE_LABEL`, `NEEDS_YOU`, inbox `waiting()`: `limit` and `background` values become unreachable.
- `ctxMeter`/`ctxMenu`: `!draft` in `canCompact` is pane-only.
- f-wip.js `addToChat`: filter to chat sessions. f-review.js `api('send')` works for chat.
- `SWITCHING`/`SWITCHED` (server.js ~128): remove the switch writes, keep the chat-move use.

### Runner start points (step 4)
- `headless.launch()`: `tmux new-session -d -s name -x 220 -y 50 -c cwd -e BEAST_DASH_PORT=… <runnerCmd>` then `claude.markChat`. Callers: `start`, `launchChat`/`startChat`/`forkChat` (via `chatQueue`), `restoreClaude` chat branch, `claude-resume` mode chat.
- `headless.respawn()`: `tmux respawn-pane -k …` then waits for the socket. Used by `chat-move`, the old switch, runner restarts.
- "Open this chat in a terminal": `actions.shellSession` running `claude --resume <id>` with `CLAUDE_CONFIG_DIR` for company (reuse `claudeCmd` env logic). Two processes on one session id if the runner is live: decide pause/stop.

## Entry points -> chat (done)

Every dashboard route and UI entry that starts or resumes Claude now starts a chat session (headless runner). Interactive Claude in a tmux pane can no longer be started from HTTP. Plain shells (`sh-N`) are unchanged.

- Project card "Claude" menu: New chat (opens the new-chat modal for that project/account), running chats, Resume last chat in this folder (disabled with a hint when there is none), Chat in a git worktree. Terminal items, "Another instance", "Copy ssh command" are gone.
- `claude` route: chat only. Options: plain (new chat), `resume` (newest conversation whose folder is the project), `worktree` (creates `<repo>/.claude/worktrees/<name>` on branch `worktree-<name>` with `git worktree add`, then starts a chat there). New `GET history-last` tells the menu whether a previous conversation exists. Worktree name validation and creation live in `lib/worktrees.js` (`validName`, `create`), the folder lookup in `lib/history.js` (`latestFor`).
- `claude-resume`: always a chat. `claude-restore` / auto-restore: records of old terminal sessions come back as a chat that resumes the same conversation (needs a conversation id). `handoff`: starts a chat on the other account. `task-run`: starts or reuses a chat only (a non-chat session is rejected). `claude-restart`: chat sessions only. `claude-switch`: only the terminal -> chat direction is left.
- Removed from `lib/actions.js`: `claudeCmd`, `launchClaude`, `claudeSession`, `resumeHere`, `respawnShell`. Pane scraping and send-keys code is still there, but no route starts a pane Claude any more.
- New-session modal: "Terminal in a project..." is gone; the old picker (fallback only) now starts chats. "+ Plain shell" stays. Palette "New terminal" removed. "Start all" starts a chat for a saved Claude entry (skipped when that account already has a chat running on the project).
- Session bar: Terminal/Chat switch, "Continue in chat", `TERM.mode`, `TERM.forceTerm`, `bd.mode`, `?mode=chat` links and the `^C` and y/n composer keys are gone. Chat sessions keep "Runner log" in the Options menu and "Back to chat".
- Past conversation view: "In terminal" removed, "Continue in chat" stays.

Left for later tasks (no chat equivalent yet or still pane code): Hand off button (needs the `limit` state, gap A), restart/update buttons shown for old terminal sessions (the route now answers with a clear error), `restartIdleTerms` banner, README text, `claude-switch` route itself.

## Review fixes (done)

Fixes for the review of "Start chats from every entry point".

- Restore and `claude-switch` now start the chat in the folder that holds the conversation file: `headless.locateTranscript` walks up from the record's folder (both config dirs when the account is unknown; the account comes from the record, else a `-company` suffix in the session name). No file found: terminal records are refused with an error instead of silently starting an empty conversation. `forkChat` uses the same helper. Test: `test/locate.test.js`.
- A conversation that is already live is opened instead of started twice (`resumeChat`, `restoreClaude`). After a resume, gone records of the same conversation are forgotten (`claude.forgetGone`), so the restore banner has no duplicates.
- `history.latestFor` refreshes the index incrementally (`refresh(true)`), so a chat that just finished is found. Test in `test/history.test.js`.
- New chat names skip names that still have a record, so gone records keep their own name and stay restorable.
- Auto-restore, the banner and `claude-restore` only offer chats and `claude-*` records, not plain `sh-N` shells where claude was run by hand.
- Restore feedback in the UI is per item (error toast for failures, only started sessions are opened); records without a conversation id are forgotten.
- Claude menu: no menu when the card was re-rendered during the history lookup. `&mode=chat` removed from push and menubar links. README describes the chat-only flow.
