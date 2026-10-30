# New project

Goal: start a brand-new project from the dashboard. Pick where it goes (an org folder under `devRoot`, or a group folder inside one, or a new org folder), type a name, pick the account, press Create. The server makes the folder, runs `git init`, rescans, and the dashboard opens the existing New chat modal with the new project already picked, so the first message goes straight to Claude in it.

Out of scope: templates/scaffolding, remotes, an initial commit, folders outside `devRoot`.

## Decisions

- Always `git init` (branch `main`). Without `.git` or a manifest the folder is not a project to `lib/discovery.js` and would never show up.
- Only inside `devRoot`, at least one level down (`<org>/<name>`), never inside an existing project, never deeper than `scanDepth`.
- The first message is not part of this form: after Create, the New chat modal opens on the project (voice, guess chip, account all already there).
- A new org folder remembers the chosen account in `settings.orgAccounts[org]`. Existing orgs are left alone.

## Contract (frozen)

`POST /api/project-new` (same-origin like every other /api POST)

Request:
```json
{ "org": "acme", "group": "tools", "name": "my-app", "account": "personal" }
```
- `org` (required): one path segment, `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, not `.`/`..`. May be a folder that does not exist yet.
- `group` (optional): `/`-joined segments, each matching the same rule; must already exist under `devRoot/<org>`.
- `name` (required): one segment, same rule.
- `account`: `"personal"` or `"company"`; anything else → `"personal"`.

Checks (in order, first failure wins):
1. Shape/regex → 400 `{ ok:false, error }`.
2. `parent = devRoot/org[/group]`. If `group` is given, `parent` must exist and be a directory → 400.
3. `realpath(parent)` (or of the nearest existing ancestor when the org is new) must be inside `realpath(devRoot)` → 400 (symlink escape).
4. No directory from `devRoot/org` down to `parent` may itself be a project (`.git` or a manifest, same rule as discovery) → 400 "inside project <rel>".
5. Depth of `org[/group]/name` must be ≤ `scanDepth` → 400.
6. `devRoot/org[/group]/name` must not exist → 409.

Action: create the org folder if missing, `mkdir` the project folder, `git init -b main` (fallback: `git init` + `git symbolic-ref HEAD refs/heads/main`). On failure remove only what this request created and answer 500. Then set `orgAccounts[org]` if the org was new, rescan (waits for a scan already running), push state.

Response 200:
```json
{ "ok": true, "id": "acme--tools--my-app", "path": "/home/u/dev/acme/tools/my-app", "rel": "acme/tools/my-app", "account": "personal" }
```
`id` is the discovery id of the new project. If the rescan does not find it, still 200 with `id: null` (the folder exists; the UI says "created, will show after the next scan").

## Frontend

`public/f-newproj.js|css`, registers `FEAT.newproj = { open(opts) }`.
- Entry points: a "+ New project" button in the Projects view bar (`#view-projects .pbar`), a command palette action "New project", and a "+ New project…" row at the end of the New chat modal's project picker (optional, only if it is a one-liner hook).
- Modal: Where (list of org folders + their group folders from `S.projects`, plus "New org folder…" with a text input), Name (live validation with the same regex, shows the resulting `~/dev/...` path, 409 shown inline), Account segment (default: the org's usual account as in `f-wip.js` `orgAccounts()`, else `localStorage bd.nt.acct`), Create button.
- On 200: toast, wait (up to ~3 s) until `S.projects` has `id`, then `newSessionModal('new', '', { project: id, account })`. On `id: null`: toast and close.
- Works on the phone (sheet layout like the other modals), no hover-only controls.

## Tasks

| # | Task | Model | Owns | Depends |
|---|---|---|---|---|
| T1 | Contract (this file) | Opus | docs/new-project/ | — |
| T2 | Endpoint + `lib/newproject.js` + `test/newproject.test.js` | Opus | server.js (one case), lib/newproject.js, lib/discovery.js (export isProjectDir), test/newproject.test.js | T1 |
| T3 | Modal + entry points | Sonnet | public/f-newproj.js, public/f-newproj.css, index.html (script/link + bar button), app.js (palette action only) | T1 (parallel with T2) |
| T4 | Gate, reviewer (Opus), merge, deploy after the user's go | Opus | — | T2, T3 |

Gate: `node --test test/*.test.js && bin/gate.sh 8797`
