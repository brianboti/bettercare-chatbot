# Spec: AI Chat over a SharePoint Site

> **Status (v3).** This is the original long-term spec. What's built differs in
> storage: the search index is files loaded into memory (BM25 + local
> embeddings), not PostgreSQL + pgvector, and the app database is Firestore
> (SQLite on a laptop). The README's "Settings", "Data", "Database" and
> "Deploying" sections describe the deployment. The Graph sync, SPFx and
> Entra ID parts are still the plan.

A chat assistant that answers questions from the content of one SharePoint Online site,
with citations back to the source documents.

Architecture: **thin client + backend RAG service**. All content acquisition, indexing,
retrieval, and LLM calls happen server-side. The client is a chat UI and nothing more.

> **Read this first if you're new to SharePoint.** Sections 1–3 exist because SharePoint's
> permission model is the single biggest constraint on this project, and it is not obvious.
> Skipping them will cost you a rebuild.

---

## 1. SharePoint glossary (only the terms this spec uses)

| Term | What it actually is |
|---|---|
| **Tenant** | Your whole organization's Microsoft 365 instance. |
| **Site collection / site** | One SharePoint site with its own URL and permission root, e.g. `https://contoso.sharepoint.com/sites/bettercare`. This is the thing you administer. |
| **List** | A table of rows ("list items"). Everything in SharePoint is a list underneath. |
| **Document library** | A list whose items are files. This is where the documents live. |
| **Drive / driveItem** | Microsoft Graph's name for a document library (`drive`) and a file/folder in it (`driveItem`). Same object, different API surface. |
| **Site page** | An `.aspx` page built in the browser out of "web parts". **Not scrapeable HTML** — see §7.2. |
| **Entra ID** | Microsoft's identity system, formerly Azure AD. Issues the tokens your backend will validate. |
| **App registration** | An identity in Entra ID representing your backend, so it can call APIs. |
| **Microsoft Graph** | The REST API for all of Microsoft 365 (`https://graph.microsoft.com`). How you read SharePoint content programmatically. |
| **SPFx** | SharePoint Framework — the toolchain for building web parts that run *inside* SharePoint pages. |
| **App catalog** | Where SPFx packages are uploaded before they can be used. Requires a tenant admin to create. |

### The three "admin" roles, which are not the same thing

| Role | Scope | You? |
|---|---|---|
| **Site collection administrator** (a.k.a. site owner) | One site's content and permissions | ✅ **This is what you have** |
| **SharePoint administrator** | All sites in the tenant, the SharePoint admin center, app catalogs | ❌ |
| **Global / Privileged Role administrator** (Entra) | App registrations, admin consent for API permissions | ❌ |

---

## 2. What your access does and does not allow

This table is the reason the build order in §12 looks the way it does.

| Action | Needs | You can? |
|---|---|---|
| Read every document and page in the site | Site owner | ✅ |
| Download the site's content manually or via sync | Site owner | ✅ |
| Inspect which items have unique (broken-inheritance) permissions | Site owner | ✅ |
| Add a page, a link, or a button to the site | Site owner | ✅ |
| Register an Entra app for the backend | Tenant policy (often allowed for all users, often not) | ⚠️ Maybe |
| **Grant admin consent for `Sites.Selected`** | Global / Privileged Role admin | ❌ |
| **Grant the app a role on your site** (`POST /sites/{id}/permissions`) | `Sites.FullControl.All` — i.e. SharePoint admin | ❌ |
| **Create a site collection app catalog** (to deploy SPFx) | SharePoint admin | ❌ |
| Embed an external iframe in a page | Domain allowlist, often tenant-controlled | ⚠️ Maybe |

**Conclusion: you need exactly one conversation with a tenant admin.** §13 is a copy-pasteable
request for it. Everything up to Phase 6 is buildable without them, which is why Phase 0 exists.

---

## 3. Decisions

These replace the usual "assumptions" section. Each one is a real fork; pick deliberately and
record the choice, because two of them are expensive to reverse.

### D1 — How content gets in

| Option | Needs admin? | Verdict |
|---|---|---|
| **(a) Local export**: you download the library, pipeline reads a folder | No | ✅ **Start here** |
| **(b) Graph delta sync**: app-only token, `Sites.Selected`, incremental | Yes, once | ✅ **End here** |
| (c) Client-side crawl in the browser with user cookies | No | ❌ Fragile, slow, per-user duplicate index |

**Do both, behind one interface.** `ContentSource` (§6) has two implementations. (a) lets you build
and validate the entire pipeline this week; (b) is a drop-in replacement once the admin grant lands.
Nothing downstream of the port changes. This is the main reason the spec is structured around ports.

### D2 — Security trimming

**The risk:** SharePoint tenants are notoriously over-shared. An index that ignores per-item
permissions turns every mis-permissioned document into a searchable, summarizable answer. A chatbot
is a far more efficient leak than a search box, because it will paraphrase and volunteer content
nobody thought to search for.

| Option | When it's correct |
|---|---|
| **(a) No trimming, gate at the door** — index everything, allow only users who can access the site | **Only if the site's permissions are uniform** (§4, P1). Recommended if the check passes. |
| (b) Trim to uniform subset — index only libraries with no broken inheritance | Check partially fails |
| (c) Per-user trimming — store ACLs per chunk and filter at query time, or retrieve via delegated Graph Search | Check fails badly, or the site later grows mixed permissions |

**Recommended: (a), conditional on P1 passing, re-checked on every sync.** Uniform permissions on a
single site is the common case and it collapses an enormous amount of complexity. But it is a
*precondition you must verify*, not an assumption you may make — and it can silently stop being
true the day someone shares one file with a guest. The sync job asserts it every run (§7.1) and
refuses to index anything with broken inheritance.

### D3 — Where the chat UI lives

| Option | Needs admin? | Verdict |
|---|---|---|
| **(a) Standalone web app**, linked from a button on the site home page | No | ✅ **v1** |
| (b) SPFx web part, embedded in a SharePoint page | Yes (app catalog) | ✅ v2, if the UX matters |
| (c) Chrome extension side panel | No, but needs MSAL in the extension + per-user install | ❌ Only if answering from *outside* SharePoint is a requirement |

(a) works in every browser, deploys like any web app, and the "integration" is a link — which you
can add yourself, today. (b) is nicer (it lives inside the page, and auth comes free from the
signed-in session) but it's a new toolchain plus a tenant-admin dependency, so it is not v1.

### D4 — Retrieval

**Own hybrid index** (pgvector + Postgres full-text, fused). Graph Search as the retriever was
considered: it gives per-user security trimming for free, but you lose all control over chunking,
embeddings, and ranking — which is where answer quality actually comes from. With D2(a) you don't
need Search's trimming, so its main advantage doesn't apply.

Keep it behind the `Retriever` port anyway. If D2 ever flips to (c), a `GraphSearchRetriever`
becomes the cheapest path to correctness.

---

## 4. Preconditions — verify before building

Each has a concrete check. Do not proceed past Phase 1 with an unverified P1.

- **P1 — Permissions are uniform within the site.** No list, library, folder, or file has unique
  permissions; everyone who can open the site can open everything in it.
  *Check:* for each list, read `HasUniqueRoleAssignments`; for items, look for broken inheritance.
  PnP PowerShell (`Get-PnPList`, `Get-PnPListItem` + `Get-PnPProperty -Property HasUniqueRoleAssignments`)
  is the usual tool. **Automate this as `scripts/check-permissions.ts` and run it every sync**, not once.
  *If it fails:* note exactly which libraries, and restrict the index to the clean ones (D2b).
- **P2 — No external/guest users on the site,** or you accept that they get the same answers.
  *Check:* site permissions page; look for accounts containing `#EXT#`.
- **P3 — You know what's actually in the site.** Count files by extension and size. A site that is
  90% `.xlsx` needs a very different extractor story than one that is 90% `.docx`.
  *Check:* Phase 0 export, then `scripts/inventory.ts`.
- **P4 — Content is text-bearing.** Scanned PDFs with no text layer will silently index as empty.
  *Check:* the inventory script flags PDFs whose extracted text is under a threshold.
- **P5 — Nothing in the site is regulated beyond your authority to index** (FERPA/HIPAA/PII).
  *Check:* human review of the inventory. This is a judgment call, not a script.

---

## 5. System overview

```
┌──────────────────────┐         ┌────────────────────────────────────────┐
│  Web app (React)     │  HTTPS  │  Backend                               │
│  ┌────────────────┐  │ ──────▶ │  ┌────────┐    ┌──────────────┐        │
│  │  Chat UI       │  │   SSE   │  │ Chat   │───▶│  Retriever   │        │
│  └────────────────┘  │ ◀────── │  │ API    │    │  (hybrid)    │        │
│  ┌────────────────┐  │         │  └───┬────┘    └──────┬───────┘        │
│  │ MSAL sign-in   │  │         │      ▼                ▼                │
│  └────────────────┘  │         │  Claude API      Postgres + pgvector   │
└──────────────────────┘         │                       ▲                │
         ▲                       │  ┌─────────────────┐  │                │
         │ link from site        │  │ Indexer         │──┘                │
┌────────┴─────────────┐         │  │ (scheduled)     │                   │
│  SharePoint site     │         │  └────────┬────────┘                   │
│  (button on home)    │         └───────────┼────────────────────────────┘
└──────────────────────┘                     │ ContentSource port
                                             ▼
                              ┌──────────────┴───────────────┐
                              │ LocalFolder  (Phase 1)       │
                              │ Graph delta  (Phase 6)       │
                              └──────────────────────────────┘
```

---

## 6. Ports — the contracts between modules

**This section is the architecture.** Modules talk to each other only through these types. Concrete
implementations are chosen once, at startup, in `apps/*/wiring.ts`. Nothing else imports a concrete
class. This is what makes D1 a configuration change instead of a rewrite.

All types live in `packages/shared` and are imported by both backend and web app.

```ts
// ---- Domain types -------------------------------------------------------
type SourceId = string;              // stable identity of a source document
type Cursor = string;                // opaque resume token (Graph deltaLink, or a timestamp)

interface RawDoc {
  id: SourceId;
  webUrl: string;                    // where a human goes to see this
  title: string;
  contentType: string;               // MIME type; drives extractor selection
  bytes: Uint8Array;
  modifiedAt: Date;
  etag: string;
  hasUniquePermissions: boolean;     // P1 tripwire — see §7.1
}

interface ExtractedDoc {
  id: SourceId;
  webUrl: string;
  title: string;
  sections: Section[];               // preserves heading hierarchy
}
interface Section { headingPath: string[]; text: string }

interface Chunk {
  sourceId: SourceId;
  chunkIndex: number;
  headingPath: string[];
  text: string;
}

interface RetrievedChunk extends Chunk {
  webUrl: string;
  title: string;
  score: number;
  retrievedBy: ('vector' | 'fts')[]; // for debugging retrieval quality
}

// ---- Ports --------------------------------------------------------------
interface ContentSource {
  /** Enumerate documents. With a cursor, only what changed since. */
  list(since?: Cursor): AsyncIterable<DocRef>;
  fetch(ref: DocRef): Promise<RawDoc>;
  /** Returned after a full pass; persisted and passed back next run. */
  cursor(): Promise<Cursor>;
}

interface Extractor {
  supports(contentType: string): boolean;
  extract(doc: RawDoc): Promise<ExtractedDoc>;
}

interface Chunker { chunk(doc: ExtractedDoc): Chunk[] }        // pure, no I/O

interface Embedder {
  readonly modelId: string;          // persisted per row — see §9
  readonly dims: number;
  embed(texts: string[]): Promise<number[][]>;
}

interface Retriever {
  retrieve(query: string, opts: { topK: number }): Promise<RetrievedChunk[]>;
}

interface Reranker {
  rerank(query: string, candidates: RetrievedChunk[], topK: number): Promise<RetrievedChunk[]>;
}
```

**Rules that keep this honest:**

- `Chunker` and every `Extractor` are **pure functions of their input** — no network, no database,
  no clock. They are the highest-churn, most bug-prone code in the system; this constraint makes
  them unit-testable against fixture files with zero setup.
- Only the indexer and the chat API touch the database. Extractors never do.
- Adding a file format = adding one `Extractor` and registering it. Nothing else changes.

---

## 7. Backend modules

### 7.1 — Indexer (`apps/indexer`)

Replaces the web crawler from the original design. It is a pipeline over the ports, not a crawler.

```
ContentSource.list(cursor) → fetch → Extractor.extract → Chunker.chunk → Embedder.embed → upsert
```

- **Incremental by default.** Persist the `Cursor` per source. The `GraphContentSource` uses delta
  links (`/sites/{siteId}/drives/{driveId}/root/delta`), stored **verbatim** — one per document
  library. Follow `@odata.nextLink` until an `@odata.deltaLink` is returned, and store that.
  Handle `410 Gone` / `resyncRequired` by discarding the token and doing a full resync; there is no
  supported way to resume from an expired checkpoint.
- **Skip unchanged.** Compare `etag`/`modifiedAt` before spending an embedding call.
- **Deletions are not optional.** Delta reports deleted items; the local source diffs against the
  previous manifest. Chunks for a removed document must be deleted in the same transaction.
  An assistant citing a document that was deleted *for a reason* is an incident, not a stale cache.
- **P1 tripwire.** If any fetched doc has `hasUniquePermissions === true`, **skip it, do not index it,
  and record it in the run report.** Under D2(a) the entire security model rests on P1; the indexer
  is where that gets enforced instead of assumed.
- **Idempotent.** Re-processing a document replaces all of its chunks, keyed by `sourceId`.
- **Run report.** Every run writes: documents seen / indexed / skipped (with reason) / failed,
  chunk count delta, duration, and the P1 violation list. This is your only window into the pipeline.
- Trigger: cron (§8) plus `POST /admin/reindex` (admin-token protected). A `--full` flag ignores cursors.

### 7.2 — Extractors (`packages/extractors`)

A **registry**, selected by content type. The original design's single HTML path does not survive
contact with SharePoint.

| Content | Extractor | Notes |
|---|---|---|
| `.docx` | `mammoth` or `docx` → text + heading levels | Most common; heading structure is real and worth preserving |
| `.pdf` | `pdf-parse` / `unpdf` | **Check for an empty text layer** (P4). Scanned PDFs need OCR or exclusion — decide, don't silently index nothing |
| `.xlsx` | `exceljs` → sheet-per-section, row-wise text | Tables chunk badly; consider excluding unless P3 says they matter |
| `.pptx` | slide text + speaker notes | One section per slide |
| `.txt` / `.md` | passthrough | |
| Site pages (`.aspx`) | Graph pages API → walk the web-part JSON | **Not HTML.** Modern pages store content as structured web-part data; fetching the URL and running an HTML readability pass gets you a shell. Verify the current Graph route and the scope it requires — page reads may need broader permission than `Sites.Selected` grants |

Unsupported types are skipped and counted in the run report, never silently dropped.

### 7.3 — Chunking (`packages/chunker`)

- Split on section boundaries first, then pack to the target token size; never merge across documents.
- Prepend `headingPath` to each chunk's embedded text (`"Benefits > Dental > Eligibility\n\n…"`).
  Cheap, and it measurably improves retrieval on documents where a section is meaningless without
  its parent heading.
- Overlap only *within* a section.
- Pure function. Golden-file tests: fixture in, expected chunks out.

### 7.4 — Index & retrieval (`apps/api/retrieval`)

- **Hybrid.** pgvector cosine search and Postgres FTS (`tsvector`) over the same `chunks` table.
- Run both at `RETRIEVAL_CANDIDATES` (default 20), fuse with Reciprocal Rank Fusion, cut to
  `RETRIEVAL_TOP_K` (default 8).
- Record `retrievedBy` on each result. When retrieval is bad, the first question is always "did
  vector or keyword find this?" — answer it from the data, not by re-running things by hand.
- v2: rerank the fused candidates before cutting (the `Reranker` port already exists for this).

### 7.5 — Chat API (`apps/api/chat`)

`POST /chat` → `{ messages: Message[] }`, streams SSE.

**Flow:**

1. **Query rewrite** (`packages/query`) — history + latest message → one standalone question.
   This is its own module with its own tests. "What about the second one?" is the most common way
   RAG chat fails, and it fails invisibly: retrieval returns garbage and the model confabulates over it.
2. Retrieve top-K for the rewritten question.
3. Assemble the prompt (§7.6).
4. Stream from Claude.

**SSE protocol** — defined once in `packages/shared`, imported by both sides:

| Event | Payload | When |
|---|---|---|
| `sources` | `{ n, url, title, headingPath }[]` | **First**, before any token — retrieval is already done, and the UI needs them to render `[n]` as links *during* streaming |
| `token` | `{ text: string }` | Per delta |
| `error` | `{ code: ErrorCode, message: string }` | Any mid-stream failure |
| `done` | `{ finishReason, promptVersion, latencyMs }` | Terminal |

Every stream ends in exactly one `error` or one `done`. Without an `error` event, a mid-stream
failure just hangs the client forever.

### 7.6 — Prompting (`packages/prompt`)

Prompts are **versioned source files**, not string literals inline in a request handler. Export a
`PROMPT_VERSION` and log it with every turn (§9) — otherwise you cannot attribute a quality change
to a prompt change, and you will make many prompt changes.

Composable pieces: base instructions · citation format · low-confidence hedge · no-answer behavior.

```
You answer questions about {SITE_NAME} using only the provided excerpts.
Cite every claim as [n], matching the excerpt numbers.
If the excerpts do not contain the answer, say so plainly. Do not guess, and do not
use knowledge from outside the excerpts.
```

- If the top fused score is below `LOW_CONFIDENCE_THRESHOLD`, append a hedge instruction. Retrieval
  failure should surface as "I don't have that" rather than as a confident wrong answer.
- Excerpts are numbered and carry their title + heading path.

**Claude API settings** (verified against the current API, September 2026):

| Setting | Value | Why |
|---|---|---|
| `model` | `claude-opus-5` | Current default. `claude-sonnet-5` ($2/$10 per MTok vs $5/$25) is a legitimate cost tradeoff for a high-volume chat route — make it deliberately, and re-run the eval (§11) when you do |
| `thinking` | `{ type: "adaptive" }` | |
| `output_config.effort` | `"low"` or `"medium"` | Grounded QA rarely repays high effort. This is your main cost lever — tune it against the eval, not by feel |
| `max_tokens` | `8192`+ | You're streaming, so timeouts aren't the constraint. `1024` truncates any answer that quotes several sources |
| `cache_control` | Breakpoint after the system prompt | The system prompt is byte-identical on every request; excerpts and question are not. **Order matters** — anything volatile before the breakpoint silently kills the hit rate. Verify with `usage.cache_read_input_tokens` |
| `betas` + `fallbacks` | `["server-side-fallback-2026-07-01"]` + `fallbacks: "default"` | Routes around a refusal instead of returning nothing |

**Check `stop_reason` before reading `content`.** A refusal returns HTTP 200 with
`stop_reason: "refusal"`; code that reads `content` unconditionally produces a silent empty answer.

### 7.7 — Auth (`apps/api/auth`)

- The web app signs in with MSAL against Entra ID; the backend **validates the bearer token**
  (issuer, audience, signature via JWKS, expiry) on every request.
- Authorization: token is valid **and** the user can access the site. Cache the site-access check
  per user with a short TTL — under D2(a) this is the entire security boundary, so it is not a
  place to be clever.
- Rate limit per user object id (default 20 messages / 10 min) plus a global cap.
- Every secret — Claude key, Graph client secret — lives in backend environment config only.

### 7.8 — Admin & observability (`apps/api/admin`)

- `GET /admin/status` — documents indexed, chunks, last sync time + cursor age, P1 violations, error counts.
- `POST /admin/reindex` — manual trigger.
- **Chat log** per turn: user object id, rewritten question, retrieved source ids + scores, prompt
  version, model, token usage, latency. This is how you debug retrieval quality; without it you guess.
- **The question text is sensitive.** On an internal site people will paste confidential content into
  the chat box. Set a retention window (default 30 days), state it in the UI, make it a config value.

---

## 8. Configuration

**One module** (`packages/config`), one schema, validated with zod at startup, failing fast and loud
on a bad value. Nothing else reads `process.env`. Every tunable below appears exactly once in the
codebase — if a number in this table shows up as a literal in a source file, that's a bug.

| Key | Default | Module |
|---|---|---|
| `SITE_URL`, `SITE_NAME` | — | all |
| `CONTENT_SOURCE` | `local` \| `graph` | indexer |
| `LOCAL_CONTENT_DIR` | `./content` | indexer |
| `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET` | — | indexer |
| `SYNC_CRON` | `0 */6 * * *` | indexer |
| `SYNC_CONCURRENCY` | `4` | indexer |
| `MAX_DOC_BYTES` | `50_000_000` | indexer |
| `CHUNK_TARGET_TOKENS` | `700` | chunker |
| `CHUNK_OVERLAP_TOKENS` | `80` | chunker |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | embedder |
| `EMBEDDING_DIMS` | `1536` | embedder, schema |
| `EMBEDDING_BATCH_SIZE` | `128` | embedder |
| `RETRIEVAL_CANDIDATES` | `20` | retrieval |
| `RETRIEVAL_TOP_K` | `8` | retrieval |
| `LOW_CONFIDENCE_THRESHOLD` | tune against eval | prompt |
| `ANTHROPIC_MODEL` | `claude-opus-5` | chat |
| `ANTHROPIC_EFFORT` | `low` | chat |
| `MAX_TOKENS` | `8192` | chat |
| `RATE_LIMIT_MESSAGES` / `RATE_LIMIT_WINDOW_MIN` | `20` / `10` | auth |
| `CHAT_LOG_RETENTION_DAYS` | `30` | admin |

`EMBEDDING_MODEL` and `EMBEDDING_DIMS` are **one unit** — changing either without the other, or
without a re-index, silently corrupts the vector space and degrades retrieval in a way that looks
like a prompt problem. Validate them together, and store the model id per row (§9).

---

## 9. Data model

```sql
-- Managed with a migration tool (drizzle-kit / Atlas). No hand-applied DDL, ever.

documents (
  id            text PRIMARY KEY,        -- SourceId (Graph driveItem id, or a stable path hash)
  web_url       text NOT NULL,
  title         text NOT NULL,
  content_type  text NOT NULL,
  etag          text,
  modified_at   timestamptz,
  indexed_at    timestamptz NOT NULL,
  extractor     text NOT NULL,           -- which extractor ran; makes re-runs targetable
  status        text NOT NULL            -- indexed | skipped_unique_perms | skipped_unsupported | failed
);

chunks (
  id              bigserial PRIMARY KEY,
  document_id     text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index     int  NOT NULL,
  heading_path    text[] NOT NULL,
  text            text NOT NULL,
  tsv             tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  embedding       vector(1536),
  embedding_model text NOT NULL,         -- swap models without silent corruption
  UNIQUE (document_id, chunk_index)
);

sync_state (source_key text PRIMARY KEY, cursor text, updated_at timestamptz);
sync_runs  (id bigserial PRIMARY KEY, started_at timestamptz, finished_at timestamptz, report jsonb);
chat_logs  (id bigserial PRIMARY KEY, user_oid text, question text, rewritten_question text,
            retrieved jsonb, prompt_version text, model text, usage jsonb,
            latency_ms int, created_at timestamptz);

CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON chunks USING gin (tsv);
CREATE INDEX ON chunks (document_id);
```

Notes:

- `ON DELETE CASCADE` makes document deletion correct by construction rather than by remembering.
- `web_url` and `title` live on `documents` only — retrieval joins for them. Denormalize later if a
  query plan tells you to, not before.
- **Both search indexes are required.** Without them hybrid retrieval degrades to a sequential scan,
  and someone patches it in a panic after the first slow demo.

---

## 10. Errors

One taxonomy in `packages/shared`, one mapping to HTTP and to the SSE `error` event. The client
switches on `code`, never on message text.

| Code | HTTP | Client shows |
|---|---|---|
| `UNAUTHENTICATED` | 401 | Sign-in prompt |
| `FORBIDDEN_NO_SITE_ACCESS` | 403 | "You don't have access to this site" |
| `RATE_LIMITED` | 429 | Retry-after countdown |
| `NO_RESULTS` | 200 | "I couldn't find anything about that" (not an error state) |
| `UPSTREAM_LLM` | 502 | Retry button |
| `INTERNAL` | 500 | Generic message + correlation id |

Failures after the stream has opened arrive as an `error` event, never as a status code — the status
line is long gone by then.

---

## 11. Evaluation (`eval/`) — a first-class module, not a phase

Retrieval quality *is* the product. Treat it like code that can regress, because it will.

- `eval/questions.jsonl` — 25–50 real questions with expected source document ids. Write these
  **from the Phase 0 inventory, before building retrieval**, so they describe what users need rather
  than what your pipeline happens to do.
- `eval/run.ts` — scores **recall@8** (did the right document make the cut?) and MRR. Retrieval-only,
  no LLM: fast, free, deterministic. Runs on every change to chunking, embeddings, or fusion.
- `eval/answers.ts` — optional end-to-end pass over a subset, graded for groundedness and citation
  correctness. Costs money per run; run it before releases, not on every commit.
- Commit a baseline. A chunking change that drops recall@8 from 0.84 to 0.71 must fail CI, not
  surface three weeks later as "the bot got worse somehow."

---

## 12. Build order

Each phase has a **done** condition. Do not start the next phase until it holds.

**Phase 0 — Inventory** *(no admin needed; do this first)*
Export the site's content to a folder (sync the library with the OneDrive client, or download it).
Write `scripts/inventory.ts`: count by extension, size distribution, flag PDFs with no text layer.
Run `scripts/check-permissions.ts` for P1.
→ **Done when:** you can state what's in the site, P1 is answered yes/no, and you've hand-written
`eval/questions.jsonl`.

**Phase 1 — Pipeline against local files**
`packages/shared` types, `packages/config`, `LocalFolderContentSource`, extractor registry, chunker,
Postgres + migrations. No embeddings, no LLM yet.
→ **Done when:** the site is in `documents` + `chunks`, counts match the inventory, and you have read
30 random chunks and they're coherent. **Read them.** Bad chunks are the most common root cause of
bad answers and the easiest thing to spot by eye.

**Phase 2 — Retrieval**
Embeddings, FTS, RRF, `eval/run.ts`.
→ **Done when:** recall@8 ≥ 0.8 on the golden set, with a committed baseline. If it isn't, fix
chunking — do not proceed and hope the LLM covers for it. It won't; it will confabulate instead.

**Phase 3 — Chat API**
Query rewrite, prompt assembly, Claude streaming, SSE with all four events. Test with `curl`.
→ **Done when:** answers are grounded and correctly cited, and a forced mid-stream failure produces
an `error` event rather than a hang.

**Phase 4 — Web app**
React chat UI, MSAL sign-in, streaming render, `[n]` citations as links, source footer.
States: signing in · connecting · streaming · error+retry · rate-limited · no-results.
→ **Done when:** someone who isn't you completes a real task without being told how.

**Phase 5 — Hardening**
Token validation, site-access check, rate limits, chat logging + retention, admin status, run reports.
→ **Done when:** a request with no token, a request with a bad token, and a request with a valid token
for a user *without* site access all fail correctly.

**Phase 6 — Graph sync** *(needs the §13 admin grant)*
`GraphContentSource` with delta. Swap `CONTENT_SOURCE=graph`. Schedule it.
→ **Done when:** a document edited in SharePoint is reflected in an answer within one sync interval,
a deleted document stops being cited, and the P1 tripwire fires on a deliberately over-shared test file.

**Phase 7 — Iterate**
Mine `chat_logs` for questions that retrieved badly. Add them to the eval set. Tune.

---

## 13. The admin request

Everything through Phase 5 needs none of this. Send it early anyway — approvals take longer than
the code does.

> I'm building an internal Q&A assistant over the SharePoint site at `{SITE_URL}`, which I administer.
> The backend needs read-only access to that one site's content. I'd like to use `Sites.Selected`,
> which is the least-privilege option — it grants access to nothing by default, only to the specific
> sites an admin explicitly assigns.
>
> Three things I need:
>
> 1. **An Entra ID app registration** for the backend (I can create it if tenant policy allows;
>    otherwise please create it and send me the client id and a secret).
> 2. **Admin consent for the `Sites.Selected` application permission** on that app. This grants no
>    access on its own.
> 3. **A `read` role on my site only**, granted to that app:
>    `POST https://graph.microsoft.com/v1.0/sites/{siteId}/permissions`
>    with `{"roles":["read"],"grantedToIdentities":[{"application":{"id":"<app-id>","displayName":"<name>"}}]}`
>    (or the PnP PowerShell equivalent). This call requires `Sites.FullControl.All`, which is why I
>    can't do it myself.
>
> The app will have read access to this one site and nothing else in the tenant. Access is revocable
> at any time by deleting that site permission, without touching the app registration.

**Later, for SPFx (D3b) only:** ask for a **site collection app catalog** on your site. That's a
one-time provisioning step a SharePoint admin performs; afterwards you can deploy web parts to your
own site yourself.

**If the request is denied:** Phase 0's local export is a working, if manual, content source.
Re-exporting on a schedule is worse than delta sync, but it is not a blocker — which is the entire
point of putting `ContentSource` behind a port.

---

## 14. Repo layout

```
packages/
  shared/        # domain types, SSE protocol, error codes — imported by everything
  config/        # zod schema, single source of every tunable
  extractors/    # one file per format + registry
  chunker/       # pure
  query/         # standalone-question rewrite
  prompt/        # versioned prompt modules
apps/
  api/           # chat, retrieval, auth, admin   (+ wiring.ts)
  indexer/       # pipeline over the ports        (+ wiring.ts)
  web/           # React chat UI + MSAL
eval/            # questions.jsonl, run.ts, answers.ts, baseline.json
scripts/         # inventory.ts, check-permissions.ts
migrations/
```

Concrete implementations are selected **only** in `wiring.ts`. If `grep -r "new GraphContentSource"`
returns more than one hit, the abstraction has already leaked.

---

## 15. Out of scope for v1

Multiple sites · per-user security trimming (revisit if P1 ever fails) · writing to SharePoint ·
OCR for scanned PDFs · reranking · conversation history across sessions · SPFx web part ·
Teams integration · non-English content.

---

## 16. Open questions

- **Excel.** Spreadsheets chunk poorly and often carry the most sensitive data. Decide from the
  Phase 0 inventory whether to index them at all.
- **Site pages vs. documents.** If most of the value is in `.aspx` pages rather than files, the pages
  extractor moves from "nice to have" to Phase 1 critical path — and it's the least standard piece
  of the pipeline.
- **Scanned PDFs.** If P4 finds many, choose: exclude them, or add OCR (a real subproject).
- **Sync frequency.** 6h is a guess. Drive it from how often the content actually changes.
- **Who else gets access.** Under D2(a), "can open the site" is the entire authorization model.
  Confirm that's the intended audience before launch.
