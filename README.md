# Sophia

**Sophia** is a RAG assistant for the UT Health San Antonio **BetterCare** SharePoint site
(`/sites/BetterCare`). Ask in your own words; it searches every page, list,
document, tip sheet and flyer on the site and answers with citations to the
exact source.

Two front ends share one backend:

| Surface | What it is | Where |
|---|---|---|
| **Chrome extension** | Side panel next to the *real* site. Works today with no SharePoint permissions. | `extension/` |
| **Site replica** | A local, near-pixel copy of the whole site with the assistant built in — the demo of what an SPFx integration would look like. | `site/` + `data/site/` |

```
                       ┌──────────────────────────────────────────────┐
 Chrome extension ───▶ │ server/  (node, localhost:8787)              │
 Site replica ───────▶ │   /api/chat    SSE: rewrite → retrieve → Claude │
                       │   /api/search  hybrid retrieval, no LLM       │
                       │   /sites/BetterCare/…  the replica            │
                       └──────────────────────────────────────────────┘
                                   ▲ data/index/chunks.json
 SharePoint ──(1) export──▶ data/site/ ──(2) npm run ingest──┘
```

## Quick start

```sh
npm install
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env      # optional; without it: retrieval-only mode
npm run ingest                                  # data/site -> data/index/chunks.json
npm start                                       # http://localhost:8787
```

- **Replica:** open <http://localhost:8787>. Use the **Search or ask Sophia**
  box in the top bar or the **Ask Sophia** button.
- **Extension:** `chrome://extensions` → Developer mode → Load unpacked →
  `extension/`. See [extension/README.md](extension/README.md).

The first start embeds the corpus locally (a few minutes on CPU); later
starts reuse `data/embeddings.json` and only embed what changed.

## Safety rule

**Everything that touches SharePoint is read-only.** The exporter issues only
HTTP `GET`s from a signed-in browser tab. Do not add `POST`, `X-HTTP-Method`,
or `$batch` to anything here. The server never contacts SharePoint.

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
- **Chat log** per turn in `data/logs/chat.jsonl` (question, rewrite,
  retrieved ids + scores, prompt version, model, usage, latency).

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

1. **Backend hosting** — run `server/` somewhere reachable (Azure App Service /
   container). Swap the local export for Graph delta sync (`site-chatbot-spec.md`
   §6–7, D1b) once an admin grants `Sites.Selected` (§13 has the request).
2. **Front end** — package `site/assistant.js` as an SPFx application
   customizer (it already targets SharePoint's DOM: suite bar search, site
   header, canvas zones). Needs a site-collection app catalog (§13).
3. **Auth** — MSAL in the SPFx package, bearer-token validation on the server
   (spec §7.7).
4. **Permissions** — the corpus currently ignores item-level permissions.
   Several libraries and pages have unique permissions; resolve that (spec
   §4 P1, D2) before exposing the assistant beyond the site's owners.

## Layout

| Path | Purpose |
|---|---|
| `server/` | API + retrieval + Claude + replica host. `config.mjs` holds every tunable. |
| `site/` | Replica renderer (`server.mjs`) and the integrated assistant UI. |
| `extension/` | Chrome MV3 side panel. `lib/` is shared with the replica. |
| `src/extract.mjs`, `src/lists.config.mjs` | List rows → chunks. All list-specific knowledge lives in the config. |
| `src/ingest/` | Pages + documents → chunks; `index.mjs` builds the corpus. |
| `tools/export-*.{js,mjs}` | Read-only site exporter + local receiver. |
| `tools/ocr-with-claude.mjs` | Transcribe images and scanned PDFs. |
| `tools/eval-retrieval.mjs` | Retrieval eval. |
| `site-chatbot-spec.md` | The production architecture spec this follows. |
| `data/site/`, `data/index/` | Export and corpus — generated, git-ignored. |

The original list-only pipeline (`npm run build`: `data/bettercare-corpus.json`
→ `data/chunks.json` → the extension's bundled offline corpus) still works and
is what the extension falls back to when the server is unreachable.
