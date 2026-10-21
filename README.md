# Sophia

**Sophia** is a RAG assistant for the UT Health San Antonio **BetterCare** SharePoint site
(`/sites/BetterCare`). Ask in your own words; it searches every page, list,
document, tip sheet and flyer on the site and answers with citations to the
exact source.

Two front ends share one backend, and **both are included**:

| Interface | What it is | Where |
|---|---|---|
| **Chrome extension** | Side panel next to the *real* SharePoint site. Signs in from SharePoint or with a password. For real users. | `extension/` |
| **Website** (site replica) | A copy of the whole BetterCare site with Sophia built in, served by the server. For demos; needs the site export. | `site/` + `data/site/` |

```
                       ┌──────────────────────────────────────────────┐
 Chrome extension ───▶ │ server/  (node, :8787)                       │
 Website ────────────▶ │   /api/chat    SSE: rewrite → retrieve → Claude │
                       │   /api/search  hybrid retrieval, no LLM       │
                       │   /signin, /api/auth/*  sign-in               │
                       │   /sites/BetterCare/…  the website copy       │
                       └──────┬───────────────────────────────┬───────┘
                              │ SQLite or Firestore           │ data/index/chunks.json
                              ▼                               │ data/embeddings.json
                    users, history, sessions                  │
 SharePoint ──(1) export──▶ data/site/ ──(2) npm run ingest───┘
```

## Quick start

Node.js **24** (`.nvmrc`).

```sh
npm ci
cp .env.example .env        # then fill in what you need; see "Settings"
npm start                   # http://localhost:8787
```

- The search index is in the repository (`data/index/chunks.json`,
  `data/embeddings.json`), so nothing needs building to run. The first start
  downloads the embedding model (~35 MB) once.
- Without `ANTHROPIC_API_KEY` Sophia runs in retrieval-only mode: answers
  show the best-matching site content.
- **Sign-in:** by default (`AUTH_MODE=password`) everything needs a signed-in
  person. Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` in `.env` for a first
  admin account. For local development without sign-in, set
  `AUTH_MODE=header`: the website's avatar menu then switches between demo
  people.
- **Website:** open <http://localhost:8787> (needs the site export in
  `data/site/`; see "Data"). Without it the server still answers the extension.
- **Extension:** `chrome://extensions` → Developer mode → Load unpacked →
  `extension/`; set the server address in its settings (gear icon). See
  [extension/README.md](extension/README.md).

| Command | What it does |
|---|---|
| `npm start` | the server (`node --env-file-if-exists=.env server/index.mjs`) |
| `npm test` | unit tests (no network, no AI, no database file) |
| `npm run test:integration` | the real server's API, with and without sign-in |
| `npm run test:e2e` | a real browser on the website and the extension (needs `npx playwright install chromium` and the site export) |
| `npm run test:firestore` | the database, sign-in and API tests on Firestore's local emulator (needs `gcloud components install cloud-firestore-emulator` and Java 21+) |
| `npm run build` | everything generated: the list corpus, the extension's offline corpus, a search check, and the search vectors (`build:index`) |
| `npm run build:index` | the search vectors for the committed chunks (and the model download); `-- --ingest` first rebuilds the chunks from the site export |
| `npm run users -- …` | sign-in accounts: `list`, `add <username> [--name …] [--role …] [--admin]`, `password <username>`, `admin <username> on\|off` |
| `npm run seed:demo` | demo people, a month of questions and pushed content (`DEMO_PASSWORD` lets you sign in as them) |

## Settings

Every setting is an environment variable, read in one place
(`server/config.mjs`) and listed with its default in
[`.env.example`](.env.example). The ones a deployment sets:

| Setting | Deployed value | Notes |
|---|---|---|
| `HOST`, `PORT` | `0.0.0.0`, `8787` | the Docker image sets both; on Cloud Run, GKE or App Engine `HOST` defaults to `0.0.0.0` anyway |
| `ANTHROPIC_API_KEY` | secret | Claude; without it, retrieval-only |
| `OPENAI_API_KEY` | secret (optional) | backup when Claude can't be reached |
| `DATABASE` | `firestore` | `sqlite` is for laptops and tests |
| `FIRESTORE_PROJECT_ID`, `FIRESTORE_DATABASE_ID` | your project, `(default)` | credentials come from the service account |
| `FIRESTORE_COLLECTION_PREFIX` | e.g. `demo_` | to keep two deployments apart in one database |
| `AUTH_MODE` | `password` | the default |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | `admin`, secret | the first admin, created at startup |
| `ALLOW_SIGNUP` | `1` for an open demo | lets people make their own account |
| `SHAREPOINT_SIGNIN` | `1` for the extension demo | see "Sign-in" |
| `SITE_DIR` | `/data/site` | where the site export is mounted (the image's default) |
| `CHUNKS_FILE`, `EMBEDDINGS_FILE` | in the image | the search index; override to load another |

## Data

| What | Where | In git? | How to make it |
|---|---|---|---|
| Search chunks | `data/index/chunks.json` (9.5 MB) | yes | `npm run ingest` from the site export |
| OCR text for images and scanned PDFs | `data/index/ocr.json` | yes | `tools/ocr-with-claude.mjs` (calls Claude; costs money) |
| Search vectors | `data/embeddings.json` (22 MB) | yes | `npm run build:index` (about 3 minutes on a laptop when built from nothing; the Docker build runs it) |
| Embedding model | `MODEL_CACHE_DIR` | no | downloaded by `build:index` or on first start |
| Site export | `data/site/` (5.7 GB: 5.2 GB of documents, ~590 MB of pages, lists and snapshots) | no | the exporter (step 1 below), from a browser signed in to SharePoint |

The site export is only needed for the **website**, and to rebuild the
chunks. It can't be regenerated on a server (the export runs in a signed-in
browser), so it is supplied separately: copy it to a Cloud Storage bucket
and mount the bucket at `SITE_DIR`:

```sh
gcloud storage rsync --recursive data/site gs://<bucket>/site
```

Without `files/` (the 5.2 GB of documents) the website still works; links
to documents then open on the real SharePoint site.

## Database

`DATABASE=sqlite` keeps everything in one file (`SOPHIA_DB`, created on
first start). `DATABASE=firestore` uses Cloud Firestore in Native mode:

- Create the database once: `gcloud firestore databases create --location=<region>`.
- Give the service account the server runs as `roles/datastore.user`.
- No indexes to create: every query is on a single field.
- Collections: `users`, `turns`, `events`, `llmCalls`, `promotions`,
  `credentials`, `sessions` (each with `FIRESTORE_COLLECTION_PREFIX` in front).

## Sign-in

All sign-in methods end in a **session** (`server/auth.mjs`): a random token
whose SHA-256 is stored in the database. The website keeps it in an HttpOnly
cookie; the extension sends it as `Authorization: Bearer`.

- **Password** (the demo sign-in): accounts in the database, passwords hashed
  with scrypt. Accounts come from `ADMIN_USERNAME`, `npm run users -- add`, or
  the sign-in page when `ALLOW_SIGNUP=1`.
- **SharePoint** (extension, `SHAREPOINT_SIGNIN=1`): the extension reads who is
  signed in to SharePoint in the browser (`/_api/web/currentuser`, read-only)
  and signs them in as that work email, with no password. The server can't
  verify what the extension sends, so this is for demos only.
- **Microsoft (Entra ID)**, once IT registers the app: one more method that
  validates a Microsoft ID token and starts the same kind of session. Users,
  history and admins don't change. Use the work email as the user id so it
  matches SharePoint sign-in.

`AUTH_MODE=header` turns sign-in off and trusts the `X-Sophia-User` header.
It's for local development and the tests only.

## Deploying

The [`Dockerfile`](Dockerfile) builds the server image: production
dependencies, the embedding model, and the search vectors (`npm run
build:index`). The container runs as the unprivileged `node` user, writes
only under `/tmp`, logs each question as JSON to standard output, and starts
in a few seconds (health: `GET /api/health`).

```sh
docker build -t sophia .
docker run -p 8787:8787 --env-file .env -e DATABASE=sqlite -v "$PWD/data/site:/data/site:ro" sophia
```

On Cloud Run:

- **Memory**: 1 GiB minimum (the server uses about 500 MB with the index and
  model loaded); 2 GiB recommended. 1 vCPU is enough.
- **Settings**: as in "Settings" above, with the keys and `ADMIN_PASSWORD`
  from Secret Manager.
- **Site export** (website only): a Cloud Storage volume mounted read-only at
  `/data/site`.
- **Database**: Firestore, as in "Database". SQLite in the container would
  lose everything on each restart.
- **Extension**: it already allows `https://*.run.app`; set the service URL
  in its settings. A custom domain is asked for once when you save it.

## Personal assistant features

Sophia knows who is asking: the signed-in person (or, with
`AUTH_MODE=header`, the person picked in the avatar menu next to **Ask
Sophia**; "Someone new" shows the first-visit introduction):

- **Introduction** on first visit: asks your name and role, one question at a time.
- **Welcome cards** built for you: what Clinical IT wants your role to see, a next
  step on what you asked before, what people in your role ask, and what's new.
- **History** (clock icon): past conversations, reopen and continue.
- **Answers sized to the question**, with quick replies when Sophia needs one more
  detail, related questions, thumbs up/down, **Shorter** and **More detail**.
- **Insights dashboard** at `/admin` (an admin account, e.g. Taylor Brooks from the demo data): what people ask by
  role and topic, where they struggle, what they open, and the pushed content.

Plans and status: [docs/ROADMAP.md](docs/ROADMAP.md).

## Safety rule

**Everything that touches SharePoint is read-only.** The exporter issues only
HTTP `GET`s from a signed-in browser tab, and the extension's only SharePoint
request is `GET /_api/web/currentuser` (who is signed in). Do not add `POST`,
`X-HTTP-Method`, or `$batch` to anything here. The server never contacts
SharePoint.

## 1. Export (full site, read-only)

SharePoint auth cookies are HttpOnly, so node can't fetch the site without an
app registration. Instead the export runs in a signed-in Chrome tab and streams
everything to a local receiver:

```sh
npm run export:receiver                          # listens on 127.0.0.1:8799
```

Then, in DevTools on any BetterCare page:

```js
eval(await (await fetch('http://127.0.0.1:8799/exporter.js')).text());
await bcExport.run();          // site, lists, pages, files, snapshots
bcExport.state                 // progress
```

Chrome asks once to allow the site to reach local-network devices — allow it.
Keep the tab **active** while snapshots run (Chrome throttles rendering in
background tabs, and SharePoint renders sections lazily). The export resumes:
re-running skips files already received intact.

| Output (`data/site/`) | Contents |
|---|---|
| `site.json` | web info + the full navigation tree |
| `lists/*.json` | every visible list: schema + all rows |
| `pages/*.json` | every Site Page incl. `CanvasContent1` (authored web-part layout) |
| `files.json`, `files/` | every file in every library (~3,600 files, 5.6 GB) |
| `snapshots/*.html` | each page as rendered, CSS inlined, collapsible sections expanded, images saved to `snapshots/assets/` |

SharePoint throttles bulk reads with a **200 OK HTML error page**, not a 429;
the exporter checks every file against the manifest size and backs off.

## 2. Ingest

```sh
npm run ingest
```

`src/ingest/index.mjs` turns the export into one corpus with a single chunk
shape, whatever the source:

| Source | Module | Notes |
|---|---|---|
| List rows | `src/extract.mjs` + `src/lists.config.mjs` | per-list field mapping; placeholders, test lists, hidden rows dropped *and reported* |
| Site Pages | `src/ingest/pages.mjs` | authored canvas text + text only visible when rendered (FAQ accordions, news/event rollups); split by heading |
| Documents | `src/ingest/documents.mjs` | PDF (per page), Word (by heading), PowerPoint (per slide + notes), Excel (per sheet), text/HTML/ICS; identical copies indexed once |
| Images, scanned PDFs | `tools/ocr-with-claude.mjs` | Claude transcribes flyers/screenshots so their printed words are searchable |
| Video/audio | name + folder only | findable, not transcribed |

List rows are linked to the page that displays them, so a citation opens where
a user would actually see the item. `data/index/report.json` records every
exclusion and why.

Excluded by rule (see `PAGE_EXCLUDE` and `lists.config.mjs`): test/demo/OLD
pages, untitled drafts, lorem-ipsum lists, template rows, and list rows hidden
on the live site.

## 3. Retrieval and answers (`server/`)

- **Hybrid retrieval** (`retriever.mjs`): BM25 over titles + text (with a small
  Epic-vocabulary synonym map: phone → Haiku, lab → Beaker, …) and local
  `bge-small-en-v1.5` embeddings (transformers.js, no API key), fused with
  Reciprocal Rank Fusion; max 3 chunks per source so one long PDF can't crowd
  out everything else.
- **Query rewrite** (`llm.mjs`, `prompt.mjs`): Claude turns follow-ups into
  standalone questions and adds the site's vocabulary (surgeon → OpTime, lab →
  Beaker); the user's words and the rewrite are both searched and fused.
- **Dates** (`facts.mjs`): "the last / next / previous upgrade" is resolved
  against today's date and the site's Upgrade Timeline list, in every spelling
  the site uses (vFebruary2026, vFeb2026, vFeb26). This happens in retrieval
  itself, so the search box gets it too, and the schedule is given to Claude.
- **Broad questions** ("what's new for surgeons", "summarize…") get 16
  passages, up to 8 from one deck, and an instruction to group by application.
- **De-duplication**: the same deck as PDF and PowerPoint shares one budget,
  repeated calendar rows are capped at 2, near-identical passages are dropped,
  and web parts copied onto many pages are indexed once.
- **Answer** (`chat.mjs`): `claude-opus-5`, adaptive thinking, effort `low`,
  streamed. Every claim cited `[n]`; says so plainly when the site doesn't
  cover something. Server-side refusal fallback is on (`fallbacks: "default"`).
- **SSE protocol** documented in `extension/lib/chat-api.js` — every stream
  ends in exactly one `done` or `error`.
- **Chat log** per turn in `CHAT_LOG` (`data/logs/chat.jsonl`, or standard
  output in Docker): question, rewrite, retrieved ids + scores, prompt
  version, model, usage, latency.

Config lives in `server/config.mjs` (env overrides): model, effort, top-k,
candidates, confidence threshold, rate limit.

### Eval

```sh
npm run eval           # recall + MRR over 30 real questions, and 5 off-topic ones
```

Current: **recall = 1.00 (30/30), MRR ≈ 0.80, off-topic flagged 5/5** (top 8, or top 16 for broad questions). Run it after
any change to ingestion, chunking, embeddings or ranking; add questions from
`data/logs/chat.jsonl` that retrieved badly.

## 4. The replica (`site/`)

`site/server.mjs` serves the export at the same paths SharePoint uses
(`/sites/BetterCare/SitePages/Haiku.aspx`, `/sites/BetterCare/Shared Documents/…`),
so internal links work unchanged. Each page is its rendered snapshot with the
suite bar and site header grafted in, links kept local (anything not exported
opens on the real site), and `site/assistant.js` injected:

- **Search or ask Sophia** in the suite bar: live semantic results as you
  type, Enter asks the assistant, and **Compare with classic search** shows
  what an exact-keyword search returns for the same words.
- **Assistant pane** (suite-bar button or floating launcher), Copilot-style.
  The conversation survives navigation.
- **Citations** open the cited page, expand its collapsible section, scroll
  to and highlight the passage. Documents open in a new tab (PDFs at the page).
- Working navigation dropdowns from the real nav tree.

It's a static capture: SharePoint's own scripts don't run, so live web parts
show their state at export time and editing controls are removed. Specifics:

- Collapsible sections were captured expanded (their web parts don't render
  otherwise); the replica re-collapses them and makes the headers work.
- The third-party **Modern FAQ** web part fails inside a frame, so the replica
  re-renders it from the list it's bound to. Other failed custom web parts
  (a news scroller) are hidden.
- Images on sign-in-only hosts are captured with `bcExport.remoteAssets()`
  (run with `npm start` up). Thumbnails served from Microsoft's CDNs can't be
  captured cross-origin; they show only in a browser signed in to SharePoint,
  and as a neutral placeholder otherwise.
- ~40 "news link" pages just redirect to outside articles; they have no local
  copy and open a "not in the replica" page with a link to SharePoint.

## Moving to the real site

The replica is the target experience. To ship it:

1. **Backend hosting** — the Docker image runs on GCP (see "Deploying"). Swap
   the local export for Graph delta sync (`site-chatbot-spec.md` §6–7, D1b)
   once an admin grants `Sites.Selected` (§13 has the request).
2. **Front end** — package `site/assistant.js` as an SPFx application
   customizer (it already targets SharePoint's DOM: suite bar search, site
   header, canvas zones). Needs a site-collection app catalog (§13).
3. **Auth** — Microsoft sign-in as a method in `server/auth.mjs` (see
   "Sign-in"); MSAL in the SPFx package, bearer-token validation on the
   server (spec §7.7).
4. **Permissions** — the corpus currently ignores item-level permissions.
   Several libraries and pages have unique permissions; resolve that (spec
   §4 P1, D2) before exposing the assistant beyond the site's owners.

## Versions

Sophia is versioned `MAJOR.MINOR.PATCH`: **major** for architectural changes
(a new service or data store, a new way of signing in or deploying),
**minor** for new features, **patch** for bug fixes and small tweaks. Every
change is noted under **Unreleased** in [`CHANGELOG.md`](CHANGELOG.md) as
it's made; then

```bash
npm run release -- patch      # or minor / major
git push lab main --follow-tags
```

bumps `package.json`, `package-lock.json` and the extension manifest, dates the changelog
section, commits, and tags `vX.Y.Z`. The running version shows in the admin
panel's footer, in `/api/health`, at server start and in every line of
`data/logs/chat.jsonl`.

## Layout

| Path | Purpose |
|---|---|
| `server/` | API + retrieval + Claude + replica host. `config.mjs` holds every setting; `auth.mjs` sign-in; `store.mjs` / `store-firestore.mjs` the two databases. |
| `site/` | Replica renderer (`server.mjs`) and the integrated assistant UI. |
| `extension/` | Chrome MV3 side panel. `lib/` is shared with the replica. |
| `src/extract.mjs`, `src/lists.config.mjs` | List rows → chunks. All list-specific knowledge lives in the config. |
| `src/ingest/` | Pages + documents → chunks; `index.mjs` builds the corpus. |
| `tools/export-*.{js,mjs}` | Read-only site exporter + local receiver. |
| `tools/ocr-with-claude.mjs` | Transcribe images and scanned PDFs. |
| `tools/eval-retrieval.mjs` | Retrieval eval. |
| `site-chatbot-spec.md` | The production architecture spec this follows. |
| `data/index/chunks.json`, `data/embeddings.json` | The search index (committed). |
| `data/site/` | The site export — supplied separately, git-ignored. |
| `Dockerfile` | The deployable server image. |

The original list-only pipeline (`npm run build`: `data/bettercare-corpus.json`
→ `data/chunks.json` → the extension's bundled offline corpus) still works and
is what the extension falls back to when the server is unreachable.
