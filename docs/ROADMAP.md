# Sophia roadmap

Requests from the product owners (Professor / Dr. Rad), 2026-09-29, and where
each one stands. Phase 1 is the personalization work; phase 2 is automated
testing, which Dr. Rad specifically wants to see.

Status: `[ ]` not started · `[~]` in progress · `[x]` done (replica) · `[x*]` done in the replica, not yet in the Chrome extension

## Phase 1 — Personal assistant

Reference point: Meta's **Muse** (Sept 2026). What we're borrowing:

- A short first-run introduction that asks the person's name and role
  instead of a long setup form, then gets out of the way.
- Suggestions offered *before* the person asks, based on what it knows about them.
- Remembering what someone asked before and building on it
  ("last time you asked about Abridge…").

### 1. Know who the user is
- [x*] Identify the signed-in user.
  - Replica (demo): a "signed in as" switcher with demo people in different roles.
  - Chrome extension (done, v3): reads the SharePoint user from the signed-in tab
    (`/_api/web/currentuser`, GET only) and signs in as them (`SHAREPOINT_SIGNIN=1`, demo only).
  - Deployed (done, v3): password sign-in with sessions (`server/auth.mjs`).
  - Production (SPFx): the page context gives the user; the server validates an Entra ID token.
- [x*] First-run introduction, Muse-style: Sophia introduces itself and asks the
      person's role (and name, when sign-in doesn't provide it).
- [x*] Store a profile per user: name, role, department, Epic applications they use.

### 2. Question history
- [x*] Keep every question and answer per user (server-side, not in the browser).
- [x*] History button in the pane: past questions by date; reopen a conversation and continue it.

### 3. Personalized suggestions ("Are you here about…?")
- [x*] Generate the welcome message and suggested questions per user from:
  - **What the org wants to push** to that role (new features, a new podcast, an upcoming upgrade)
  - **What they did before** ("Now that you've set up Abridge, want tips on editing notes?")
  - **What people like them ask** ("Other nurses are asking about…")
  - **What's new on the site** (recent news, the next upgrade)
- [x*] Admins can create, target (by role) and schedule the content they want pushed.

### 4. Memory of past questions
- [x*] Sophia sees a short profile with each question (role, recent topics, last few
      questions) and uses it when it helps, without reciting the person's history back to them.

### 5. Answer length that fits the question
- [x*] Direct questions get a short direct answer; how-to questions get steps;
      broad questions get a fuller, grouped answer. (Feedback: answers were too wordy.)
- [x*] "Shorter" / "More detail" follow-ups on every answer.

### 6. Ask for more context when needed
- [x*] When a question is ambiguous, or a troubleshooting question lacks the key detail,
      Sophia asks one short question first ("What does the error say?",
      "Have you already tried re-registering the device?") with quick-reply buttons.
- [x*] Suggested follow-up questions after an answer.

### 7. Admin insights
- [x*] Dashboard for Clinical IT: what people ask, by role and topic, over time.
- [x*] Where people end up (which sources they open) and what they can't find
      (weak matches, thumbs-down, questions asked again in different words).
- [x*] Thumbs up/down on every answer.
- [x*] Performance of pushed content (shown / clicked).

### How it's built (phase 1)
- `server/store.mjs`: SQLite (`data/sophia.db`, Node's built-in `node:sqlite`) on a laptop; `server/store-firestore.mjs`: the same methods on Firestore when deployed. Both use `server/insights.mjs` for the dashboard.
- `server/personalize.mjs`: the `<person>` block sent with each question, and the welcome screen (candidates chosen in code, phrased by Claude).
- `server/followups.mjs`: cuts the `<suggestions>` block out of the streamed answer.
- `server/topics.mjs`: the topic list and the roles offered at first run.
- `site/assistant.js`: introduction, welcome cards, history, quick replies, feedback, the demo "signed in as" switcher.
- `site/admin/`: the insights dashboard at `/admin` (admins only; Taylor Brooks in the demo).
- `npm run seed:demo`: demo people, a month of questions and three pushed items (all marked demo, removable with `-- --clear`).

### Still to decide / production notes
- **Identity.** Deployed, people sign in with a password (or, in the extension
  with `SHAREPOINT_SIGNIN=1`, as their SharePoint identity, which the server can't
  verify). `AUTH_MODE=header` trusts `X-Sophia-User` and is for local development only.
  Production should validate an Entra ID token instead.
- **Privacy.** Questions are stored with the person's identity. Before production:
  a retention period, a notice in the pane, and who can see individual questions.
  The dashboard shows role, not name, by default.
- **Podcasts and video** are indexed by title and description only. To summarize a
  podcast properly, transcribe the audio at ingest (like images are transcribed today).
- **Extension parity.** Phase 1 is built in the site replica first (the demo);
  the Chrome extension's side panel then needs the same UI.

## Phase 2 — Automated testing (Dr. Rad)

Goal: every change is checked automatically, including the UI, and an AI agent
exercises the app like a user and reports what happened; Claude then checks that report.

- [x] **Unit tests** (`npm test`, started with the phase 1 modules: store, suggestion parsing, topics, prompt): retrieval, fact resolution, chunking, prompt
      building, the user store, suggestion ranking, stream parsing. Run on every commit.
- [ ] **Retrieval eval** (exists: `npm run eval`) wired into the same test run, failing
      below the current baseline (recall 30/30, MRR 0.79, off-topic 5/5).
- [x] **API tests**: start the server against a small fixture corpus with the LLM
      stubbed; check the SSE protocol, history, suggestions, admin endpoints.
- [x] **Browser tests** (Playwright, headless Chrome): scripted flows in the replica —
      onboarding, ask, open a citation, history, feedback, admin dashboard.
- [ ] **Agent-driven exploratory testing**: an AI agent drives a real browser with a
      list of scenarios ("you're a new nurse; find how to set up Haiku"), records
      screenshots and a step log, and writes an outcome report. A second pass
      (Claude) validates the report against the screenshots and flags failures.
- [ ] **Answer-quality eval**: graded set of questions checking citations, length
      and "didn't guess" behavior, run on prompt changes.
- [ ] **CI**: GitHub Actions on the lab repo runs unit + API + browser tests on every push.
