# What's new in 3.0

- **Chat sessions.** A session is a *chat*: a headless `claude -p` that the dashboard drives itself
  and renders as a conversation. Same account, same transcript files, same cards, inbox and push.
  A past conversation can be reopened as a chat (**Continue in chat**, same conversation).
- **New chat** — type the prompt and the project is picked from what you wrote (no tokens spent on
  that); change it with one click. **Resume** searches every past conversation of both accounts.
  The mic works in the dialog.
- **Code view and work in progress.** Every repo with uncommitted changes or unpushed commits, across
  all projects, in one place: per repo, per group of repos, per git worktree branch, or per session.
  Home shows it as one line that opens Code.
- **Checkpoints.** Each Claude turn that edits files gets a snapshot; see what the turn changed and
  undo (or redo) only the files that turn touched.
- **Review tray.** Comment on single diff lines, collect the comments, send them to a session as one message.
- **Fork, settle, snooze.** Fork a chat from where it is; dim a finished session until it needs you
  again; snooze one for an hour or until tomorrow morning.
- **Claude Code version check.** A new Claude Code build is started once as a test before chats
  use it; a broken one is skipped (chats stay on the last good build), and you can pin a version.
  Chats move to a new version on their own, one by one.
- **Project icons.** Found in the project (favicon, app icon, Expo icon, Android / iOS launcher
  icons), a tech glyph otherwise; set your own or have Claude draw one.
- **Chat header and rail.** A context meter, a session menu (new chat, compact, rename, move to
  another folder, kill), a files panel beside the chat, rename from the rail.
- **A new look.** One SVG icon set instead of glyphs, tonal buttons, an indigo primary action.
- **Smaller things.** Battery tile and push, an update button for Claude Code installed with mise,
  an optional Sleep button with a wake alarm, big pastes become a file, links that open New chat
  with a prompt, more settings (see [Configuration](configuration.md)).

Upgrading from 2.x: `git pull && ./install.sh`. Nothing in `state/` needs migrating.
