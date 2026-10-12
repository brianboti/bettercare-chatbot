# Changelog

Sophia's version is `MAJOR.MINOR.PATCH`:

- **MAJOR**: an architectural change: a new service or data store, a new way
  of signing in or deploying, or anything that needs migration or retesting
  end to end.
- **MINOR**: a new feature or capability: something people (or admins) can
  now do that they couldn't before.
- **PATCH**: a bug fix, wording, styling or small tweak, with no new
  capability.

Every change goes under **Unreleased** as it is made. `npm run release --
patch|minor|major` turns that section into the next version, tags it
(`vX.Y.Z`) and syncs the version into `package.json` and the extension.
Changes to docs or tests alone don't need a release.

## Unreleased

## [2.8.0] — 2026-10-12

### Added
- Every answer opens with what Sophia is assuming ("You're using ProcDoc in
  Epic"), shown in an "Assuming" box above the answer, with one-tap
  corrections ("I'm not using ProcDoc") on the latest answer. She still asks
  a clarifying question when a guess would be risky.
- Every answer ends by pointing to a person: the Health IT Help Desk
  (210-450-4800 / 210-450-HELP, HealthITSupport@uthscsa.edu), cited to the
  site footer. Questions about immediate or at-the-elbow help get the help
  desk number and any on-site support the site describes.
- `npm run eval:answers` and an "Answer rules" suite in the admin Tests tab:
  six questions, including the ProcDoc follow-up conversation, checking the
  assumptions, a citation on every bullet, and the help line.

### Changed
- Every bullet and numbered step carries its own citation. The prompt asks
  for it, and the server cites any bullet the model leaves bare from the
  excerpt it matches (the SmartList answer had citations only on its
  lead-in).
- Sophia prefers the most specific source: the ProcDoc tip sheet over the
  general Thrive training objectives, for example.
- Follow-up questions keep what the person said earlier in the conversation
  (role, specialty, tool). It now outranks their profile, so an orthopedic
  surgeon with a nurse profile no longer gets nursing answers to follow-ups.

## [2.7.1] — 2026-10-09

### Changed
- Admin panel follows the Sophia design spec (BetterCare theme): always a
  white page with no dark mode, the spec's type ramp, 12px controls and 16px
  cards with soft shadows, uppercase eyebrow labels, and a focus ring in the
  primary orange. Secondary text is darker (5.2:1 contrast).
- `docs/DESIGN.md`: every Sophia screen has a white background; the dark
  palette is gone; BetterCare label3 is now `#6E6C6A` so all text passes 4.5:1.

### Fixed
- "1 errors" on the admin panel now reads "1 error".

## [2.7.0] — 2026-10-09

### Added
- OpenAI as a backup provider: when Claude can't be reached (no credit, bad
  key, outage, overload), the search rewrite, welcome cards and answers run on
  OpenAI (`gpt-5.5`, `gpt-5.4-mini` for the small jobs) with the same prompts.
  After a billing or key failure Claude is skipped for 5 minutes. Needs
  `OPENAI_API_KEY`; `LLM_PRIMARY=openai` makes OpenAI answer first.
- The spend panel prices OpenAI calls; `/api/health` and the startup line
  show the primary and backup providers.

### Changed
- `npm run compare:models` is cheaper by default (30 rewrite questions, 10
  answers) and stops at a `--budget` (default $1.50). Evals and the model
  comparison never switch to the backup.

## [2.6.0] — 2026-10-09

### Added
- Version numbers: this changelog, `npm run release`, git tags for every
  version back to 0.1.0, and the version shown in the admin panel, in
  `/api/health`, at server start and in every chat log line.

## [2.5.0] — 2026-10-09

### Added
- `npm run compare:models`: compares the current and a candidate model for the
  search rewrite (144 questions) and for answers (same passages, blind
  order-swapped judge). Saves progress and resumes.
- `REWRITE_MODEL` setting: the search rewrite can run on a different, cheaper
  model than answers. Defaults to the answer model.

### Changed
- Rewrite and welcome calls send settings each model accepts (Haiku 4.5,
  Sonnet 5.5, Opus 5.5 differ); refusal fallback only on models that support it.
- Eval question sets moved to `tools/eval-cases.mjs`.

### Fixed
- Scope eval no longer fails the correct reply "nothing in the documents says
  it has been cancelled".

## [2.4.0] — 2026-10-09

### Added
- Admin panel: long tables (What people said, Where people are struggling,
  Recent questions, Pushed content) show 10 rows a page with Previous/Next
  instead of scrolling. Up to 300 flagged and recent questions (was 60/40).

## [2.3.0] — 2026-10-09

### Added
- Admin panel: Claude spend card. Every Claude call is recorded with its
  tokens and estimated cost (new `llm_calls` table); total, cost per answer,
  cache share, daily chart, and breakdowns by kind of call and model.

## [2.2.1] — 2026-10-08

### Changed
- Admin panel: (?) tooltip explaining the pushed-content question field.

## [2.2.0] — 2026-10-08

### Added
- Comments with thumbs up/down (site pane and extension), shown under "What
  people said".
- Admin panel Tests tab: run unit tests, search accuracy and the scope eval.
- Scope eval (`npm run eval:scope`).
- Pushed content can carry a link, with link opens counted.
- Most asked table shows each question's share.
- `docs/DESIGN.md`.

### Changed
- Off-topic questions with no matching content get a fixed reply without
  calling the model; the prompt forbids general-knowledge and medical answers.
- Sources are ordered newest first, with much older matches under "Older
  results".

### Fixed
- Ingest leaves out the site admin's test content but keeps real uses of
  "test"; recovers the "Fastest University Supercomputer" news page.

## [2.1.0] — 2026-09-30

### Added
- Extension: thumbs up/down on answers, saved as feedback.

## [2.0.1] — 2026-09-30

### Fixed
- Replica: columns sit below the full-width banner on pages with a vertical
  section.

### Docs
- `docs/ARCHITECTURE.md`: data stores, proposed Google Cloud deployment,
  network segments.

## [2.0.0] — 2026-09-29

### Architecture
- A database (SQLite, `data/sophia.db`) and people: profiles, question
  history and feedback per person; a demo "signed in as" switcher.

### Added
- First-visit introduction (name and role), personalized welcome cards,
  answers sized to the question, clarifying questions with quick replies,
  related questions, Shorter / More detail, thumbs up/down.
- Insights dashboard at `/admin` and the pushed-content manager.
- Rewrite step returns topics and intent; demo seed script; first unit tests;
  `docs/ROADMAP.md`.

## [1.1.0] — 2026-09-24

### Added
- "The last / next / previous upgrade" resolved from the Upgrade Timeline.
- Broad questions get 16 passages, up to 8 per deck.

### Fixed
- Near-duplicate and boilerplate results suppressed; folder names and footer
  contacts indexed.

## [1.0.2] — 2026-09-24

### Changed
- The assistant is branded Sophia across the extension, site pane and prompt.

## [1.0.1] — 2026-09-24

### Changed
- "Ask BetterCare" buttons and search prompt renamed "Ask Sophia".

## [1.0.0] — 2026-09-24

### Architecture
- The assistant: a full read-only export of the BetterCare site, ingestion of
  pages, documents and lists into one corpus, a server with hybrid keyword +
  embedding search and streamed, cited Claude answers, and a local replica of
  the site with the assistant built in. The extension streams answers from
  the server, falling back to its bundled search offline.

## [0.1.0] — 2026-09-16

### Added
- Chrome extension with a side panel and a bundled keyword search over the
  site's content.
