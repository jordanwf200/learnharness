# Setup and operations (jordanwf200 fork)

Agent-facing runbook for this fork: what is connected to what, how to set up a machine, how to run and verify everything, and the pitfalls already hit. Product and architecture docs live in `README.md` and `docs/`; this file only covers what this fork adds and how it is operated.

## What this fork adds

| Piece | Code | Docs |
|---|---|---|
| **Claude Code provider** (`claude-code`): Anthropic models run through the locally logged-in `claude` CLI instead of an API key | `src/agent/claude-code-cli.ts`, `src/agent/claude-code-bridge.ts`, `src/agent/claude-code-stream.ts` | `docs/development.md`, "Claude Code CLI connection" |
| **Data sync**: the data directory is its own git repo; the server pulls at startup and commits + pushes every change | `src/server/data-sync.ts`, `instrumentation.ts` | `docs/development.md`, "Syncing learning records between computers" |

## Repositories

| Repo | Visibility | Local path | Holds |
|---|---|---|---|
| `jordanwf200/learnharness` (`origin`) | public fork | the project folder (e.g. `~/Desktop/learnharness`) | app code |
| `amosblomqvist/learnharness` (`upstream`) | public | (remote only) | the original project |
| `jordanwf200/learnharness-data` | **private** | `data/` inside the project folder | chats, knowledge graph, practice sets, `settings.json` |

`data/` is gitignored by the code repo. Never commit learning data into the code repo, and never put the data repo anywhere public: it holds the learner's conversations.

## Setting up a machine (macOS/Linux)

Prerequisites: git, GitHub CLI (`gh`), Node.js 22+ (CI uses 26), Claude Code.

```bash
gh auth login                       # as jordanwf200
gh auth setup-git                   # lets the server's own git pull/push use that login
claude auth login                   # the Claude account whose plan pays for model use
cd ~/Desktop && gh repo clone jordanwf200/learnharness
cd learnharness && gh repo clone jordanwf200/learnharness-data data
npm install
node node_modules/electron/install.js   # npm's allow-scripts blocks Electron's binary download
```

Windows: `npm run desktop:dev` uses POSIX `VAR=value` syntax and will not run in cmd as is. Nothing has been set up or tested on Windows.

## Running

| Command | What it runs | Data |
|---|---|---|
| `npm run desktop:dev` | `next dev` on :3000 plus an Electron window pointed at it | `data/` (synced) |
| `npm run dev` | web only, http://localhost:3000 | `data/` (synced) |
| `npm run dev:fresh` | throwaway new-user instance on :3005, no keys | `.fresh-data/`, wiped each launch, never synced |

Only one server may run against `data/` at a time (port 3000 conflicts anyway). Stop with Ctrl-C; the server makes a final commit + push on exit.

There is no packaged `.app` for this fork: `npm run desktop:dist` needs the upstream author's Apple signing setup.

## Verifying it works

- Server log at startup: `[data-sync] pulled https://github.com/jordanwf200/learnharness-data.git`, then `[data-sync] syncing <path>/data with ...`. Each commit logs `[data-sync] Sync: ...`.
- `curl -s localhost:3000/api/data-sync` → `"state":"idle"`, `"unpushed":false`. `"state":"off"` means `data/` is not a git checkout (or `LH_DATA_SYNC=0`).
- `curl -s localhost:3000/api/claude-code` → `"state":"ready"` with the account's email and plan. `logged-out` → run `claude auth login`; `missing` → install Claude Code or set `LH_CLAUDE_CODE_PATH`.
- `git -C data status -sb` → `## main...origin/main` with nothing ahead and no changes once writes settle.
- In the app: Settings → Providers → Claude Code shows "Connected"; Settings → General → Data sync shows "Up to date".

## Data sync rules

- **Pulls happen only at server start.** Stores cache records in memory, so pulling under a running server would desync them. Quit the app on one machine before using another.
- Commits batch writes (5s after the last write, at most 60s apart) with messages describing what changed, e.g. `Sync: +12 graph nodes, +3 reasoning chains, 1 session updated`.
- A rejected push rebases onto the remote and retries. A real conflict aborts the rebase, keeps the local commit, stops pushing, and shows the error in Settings → General. To resolve: stop the server, fix it with git in `data/` (`git pull --rebase`, resolve, `git rebase --continue`, `git push`), then start the server again.
- `data/.gitignore` (maintained by the server) keeps out `debug/`, `*.tmp-*` atomic-write files and any `auth.json` / `*-credentials.json`. API keys live outside `data/` (`auth.json` at the project root, gitignored).
- `LH_DATA_SYNC=0` turns sync off without removing the checkout.

## Importing study material

- In the app: "Import notes…" (top right) takes `.md`/`.txt` files and turns them into graph nodes. PDFs and slides must be converted to text first.
- Programmatically (same endpoint the button uses):
  `curl -s -X POST -H "Origin: http://localhost:3000" -F "files=@week-01.md;filename=COURSE/week-01.md;type=text/markdown" localhost:3000/api/graph/import`. Repeat `-F` for several files. The `filename` becomes the graph cluster label and the source identity.
- Split big documents (one file per week/topic) before importing: each file becomes its own cluster, files import in parallel, and a re-import reprocesses the whole file.
- Teaching and practice sessions can also read files directly by path (home-relative), so importing is not required to study from a document.
- Study material lives outside the repo (e.g. under `~/Documents/`).

## Pitfalls already hit

- **Copying the project folder can drop `.git`.** (The Claude desktop app's folder move does.) Reattach without touching files, once for the project and once for `data/` with the data repo URL:
  `git init -b main && git remote add origin <url> && git fetch origin && git reset origin/main && git branch -u origin/main`.
  Sync stays silently off until `data/.git` exists.
- **`npm install` reorders two keys in `package-lock.json`** with no version change. Revert it (`git checkout package-lock.json`), don't commit it.
- **A notes import can come back `partial`** with "the auditor never submitted a review": the auditor model (the Cheap tier) used its 16 steps without submitting. Successful chunks are already merged. Re-import only the missing chunk under the same `filename` (chunks are greedy by line, about 4096 tokens at chars/4: `chunkNotes` in `src/agent/subagents/extraction.ts`), or give the auditor role a stronger model in Settings → Agent.
- **A window opened during an import can show a stale, scrambled layout.** Reload it (⌘R in Electron).
- **Deleting imported nodes:** `DELETE /api/graph/nodes/<id>` removes a node and every chain through it. There is no whole-source delete; session deletion (`DELETE /api/chats/<id>?mode=delete-nodes`) only applies to chats.
- **Tests:** `npm test` preloads `tests/isolate-data-dir.ts` so no test writes into `data/`. On Node < 26, `tests/subscription-auth.test.ts` ("main loader resolves Pi's import-only PUBLIC package exports") fails; that is the runtime, not the code.

## Working on this repo

- Read `AGENTS.md`: the upstream owner's rules (ask before guessing design decisions; this Next.js version differs from training data).
- Gates before committing: `npm run lint`, `npm run typecheck`, `npm test`.
- Commit messages: no AI co-author trailers. Push to `origin main` only when asked.
- Pull upstream changes with `git fetch upstream && git merge upstream/main`; re-run the gates afterwards.
