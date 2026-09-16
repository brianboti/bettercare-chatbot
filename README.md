# bettercare-chat

A chatbot that answers questions from the content of the UT Health San Antonio
**BetterCare** SharePoint site (`/sites/BetterCare`).

## Safety rule

**Everything that touches SharePoint is read-only.** Only HTTP `GET` is used.
SharePoint requires `POST` plus an `X-RequestDigest` header for any write, so
the fetch below is structurally incapable of modifying the site. Do not add
`POST`, `X-HTTP-Method`, or `$batch` to any script here.

## Pipeline

```
SharePoint lists ──(1) read-only REST fetch──> data/bettercare-corpus.json
                 ──(2) node src/extract.mjs ──> data/chunks.json
                 ──(3) tools/build-extension ──> extension/  (loadable in Chrome)
```

`npm run build` runs steps 2 and 3 and the search tests. Step 1 is manual — see below.

### 1. Fetch (manual, browser DevTools console)

Run while signed in to the site, on a page of that site. Uses the browser's
existing session, so it needs no app registration and no tenant-admin consent.

```js
const SITE = 'https://uthealthsa.sharepoint.com/sites/BetterCare';
const H = { headers: { Accept: 'application/json;odata=nometadata' } };

// Always verify the site before fetching. A leading-slash path like
// `/_api/Web/Lists` resolves to the TENANT ROOT site, not this one.
const web = await (await fetch(`${SITE}/_api/Web?$select=Title,Url`, H)).json();
console.log('SITE:', web.Title, web.Url);

const lists = (await (await fetch(
  `${SITE}/_api/Web/Lists?$select=Title,Id&$filter=Hidden eq false`, H)).json()).value;

const corpus = [];
for (const l of lists) {
  const items = [];
  let url = `${SITE}/_api/Web/Lists(guid'${l.Id}')/Items?$top=500`;
  while (url) {                                  // follow paging
    const d = await (await fetch(url, H)).json();
    items.push(...d.value);
    url = d['odata.nextLink'] || null;
  }
  corpus.push({ list: l.Title, id: l.Id, items });
}

const a = document.createElement('a');
a.href = URL.createObjectURL(new Blob([JSON.stringify(corpus, null, 2)], { type: 'application/json' }));
a.download = 'bettercare-corpus.json';
document.body.appendChild(a); a.click(); a.remove();
```

> Do **not** include the `User Information List` — it holds directory PII for
> ~13,757 people and is not site content.

### 2. Extract

```sh
node src/extract.mjs data/bettercare-corpus.json --out data/chunks.json
```

One list row becomes one chunk. Rows are short and self-contained, so nothing
is split. The run prints a full audit: rows in, chunks out, which lists were
skipped and why, and every individual row that was dropped.

### 3. Load the extension

```sh
npm run build
```

Then `chrome://extensions` -> Developer mode -> Load unpacked -> select `extension/`.
Full instructions in [extension/README.md](extension/README.md).

The extension makes **no network requests at all** — it searches the bundled
corpus locally. It never reads from or writes to SharePoint.

There is also a static visual mockup at
[design/extension-mockup.html](design/extension-mockup.html) for design review.

## Layout

| File | Purpose |
|---|---|
| `src/lists.config.mjs` | Per-list rules. **All site-specific knowledge lives here.** |
| `src/extract.mjs` | Generic row → chunk pipeline. No site knowledge. |
| `src/html.mjs` | SharePoint rich-text → plain text, preserving links. |
| `extension/` | Loadable Chrome MV3 extension. See its own README. |
| `tools/build-extension.mjs` | Generates `extension/data/corpus.json` and the icons. |
| `tools/test-search.mjs` | Ranking tests — runs `extension/search.js` under node. |
| `design/extension-mockup.html` | Static visual mockup for design review. |

Pointing this at another SharePoint site means writing a new `lists.config.mjs`;
nothing else changes.

## What the extractor handles

SharePoint list columns are named by whoever created them, so the config maps
generic names (`field_2`, `field_4`) to meaning. Every mapping was derived by
reading actual row values, not column names.

- **Rich text** — strips tags, decodes SharePoint's double-encoded entities
  (`&#58;`), removes zero-width characters, and lifts `<a href>` into a `links`
  array while keeping the anchor text inline.
- **Shape variance** — the same logical value arrives as `1` or `[1]`, as
  `"yes"` or `["yes"]`, as `true` or `"True"`. Every accessor tolerates all forms.
- **Hyperlink columns** — `{ Description, Url }` objects are unwrapped.
- **Lookup joins** — `CategoryId` / `CatgId` resolve against the category lists
  (52 of 52 FAQ chunks resolve).
- **Empty titles** — `Terminology.Title` is blank on every row; the term is
  composed from `EpicTerm` + `AxiumTerm`.
- **Cross-list duplicates** — the same Q&A is copied into several lists. One
  chunk survives and records the others in `alsoIn`, so a citation can name
  every location.
- **Unpublished rows** — `Display: ["no"]` rows are kept but tagged
  `meta.published: false`, and filtered at retrieval time. The decision stays
  reversible rather than being baked into extraction.
- **Placeholder text** — lorem ipsum and `"N/A"` bodies are dropped *and named
  in the report*, never silently.

## Current corpus

432 chunks / ~21,000 tokens from 21 lists.

| kind | chunks | what it is |
|---|---|---|
| `feature` | 189 | Epic upgrade + Gen-AI feature descriptions |
| `catalog` | 142 | tip-sheet metadata (title/link only — not the file text) |
| `faq` | 52 | question/answer pairs |
| `event` | 22 | dated implementation and upgrade milestones |
| `resource` | 15 | how-to resource pages |
| `glossary` | 12 | axiUm → Epic terminology |

**Excluded lists**

| list | rows | why |
|---|---|---|
| `HOPD` | 14 | lorem ipsum bodies; every link points to `google.com` |
| `Breaking News` | 33 | every row is only a title: `"Breaking New 1".."33"` |
| `Abridge` | 7 | navigation menu, not content (reusable later as a sitemap) |

## Known limits

- **`catalog` chunks are metadata, not content.** They name a tip sheet and
  link to it; they cannot answer questions about what is *inside* it.
- **`Beaker-TipSheets` (38) is entirely external.** Every link goes to the
  Ancile uPerform LMS (`uthscsa.ancileuperform.com`), not SharePoint.
  `WisdomTipSheets` has a link on only 17 of 56 rows.
- **`Wisdom Document links` (53/53) points at SharePoint PDFs.** That column is
  the join key for indexing the actual documents in a later phase.
- **Site Pages (253) and Shared Documents (518) are not indexed yet.** Both
  have `HasUniqueRoleAssignments: true`, so permissions must be resolved before
  their content is exposed through a chatbot. Shared Documents also contains
  PII (evaluations, enrollment and survey files) and heavy duplication
  (28 identical copies of one 15 MB PDF), so it needs content-hash dedupe and a
  PII exclusion pass.
