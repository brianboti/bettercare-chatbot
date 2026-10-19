# Testing Sophia

Sophia has three kinds of automated tests. None of them call an AI model or
touch the real database (`data/sophia.db`), so they're free to run as often as
you like. Each kind can also be run from the admin panel's **Tests** tab.

| Command | What it checks | How |
|---|---|---|
| `npm test` | **Unit tests**: each function on its own (search ranking, citations, the help line, prompts, pricing, the database, document import, the extension's client code…) | `test/*.test.mjs`, under a second |
| `npm run test:integration` | **API checks**: every server route, against a real server started with a temporary database and no AI model | `test/integration/`, about a second |
| `npm run test:e2e` | **End-to-end**: a real browser (headless Chromium) uses the BetterCare site and the Sophia pane the way a person would: first visit, asking, citations, feedback, off-topic questions, history, new conversation, admin panel | `test/e2e/`, about 10 seconds |

These evals call the real model and cost money. Run them on purpose, not on
every change:

| Command | What it checks |
|---|---|
| `npm run eval` | Search accuracy on 35 fixed questions (free, no model) |
| `npm run eval:scope` | Off-topic questions are declined, real ones answered (about 1 minute) |
| `npm run eval:answers` | Answer rules: assumptions, a citation on every bullet, the help desk line (about 1 minute) |

## Setup

- `npm install`
- For end-to-end tests, one time: `npx playwright install chromium`.
- End-to-end tests also need the site export (`data/site`) and the search
  index (`data/index`). Without them, the tests skip and say why.

## Writing a test

- Use `node:test` and `node:assert/strict`, like the existing files.
- The **first line** of every test file is `// Covers: <one plain sentence>`.
  The Tests tab shows it, and a unit test checks that it's there.
- Never call a real model. `server/llm.mjs` and `server/openai.mjs` have
  `_setClientsForTest` / `_setClientForTest` for fake clients, and
  `buildRetriever` takes fake `vectors` and `embedQuery`.
- Use `openStore(':memory:')` for the database. Test servers get `SOPHIA_DB`
  and `CHAT_LOG` pointed at a temp folder (see `test/integration/server.mjs`).
- When you fix a bug, add a test that fails without the fix.
  [`BUG-EXAMPLES.md`](BUG-EXAMPLES.md) has three real ones.
