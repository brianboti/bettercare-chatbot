// Covers: Using Sophia on the BetterCare site in a real browser: the first-visit introduction, asking a question and getting a cited answer, rating it, an off-topic question, and starting a new conversation.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, missingPrereq } from './server.mjs';
import { launch, contextFor, createUser, historyOf, openPane, ask, HOME } from './browser.mjs';

const skip = await missingPrereq();

describe('the Sophia pane', { skip: skip || false }, () => {
  let srv, browser;
  before(async () => { srv = await startServer(); browser = await launch(); });
  after(async () => { await browser?.close(); await srv?.stop(); });

  test('first visit: Sophia introduces herself, asks name and role, then shows the welcome', async () => {
    const context = await contextFor(browser, srv.url, 'e2e-first-visit');
    const page = await context.newPage();
    const pane = await openPane(page);

    await pane.getByText("Hi, I'm Sophia.").waitFor();
    await pane.getByLabel('Your name').fill('Rosa');
    await pane.getByRole('button', { name: 'Continue' }).click();
    await pane.getByText('Nice to meet you, Rosa.', { exact: false }).waitFor();
    const roles = pane.getByRole('group', { name: 'Your role' });
    await roles.getByRole('button', { name: 'Nurse', exact: true }).click();

    await pane.locator('.bc-welcome h2').filter({ hasText: /Rosa/ }).waitFor();
    assert.equal(await pane.locator('.bc-intro').count(), 0, 'the introduction is gone');
    const me = await (await fetch(`${srv.url}/api/me`, { headers: { 'X-Sophia-User': 'e2e-first-visit' } })).json();
    assert.deepEqual([me.user.name, me.user.role], ['Rosa', 'nurse'], 'the profile is saved on the server');
    await context.close();
  });

  test('asking a BetterCare question gives a cited answer with sources, and a thumbs up is saved', async () => {
    await createUser(srv.url, 'e2e-asker');
    const context = await contextFor(browser, srv.url, 'e2e-asker');
    const page = await context.newPage();
    await openPane(page);

    const turn = await ask(page, 'Where are the Abridge tip sheets?');
    const answer = turn.locator('.bc-answer');
    assert.match(await answer.innerText(), /Here's what I found on the site/);
    assert.match(await answer.innerText(), /Abridge/);
    assert.match(await answer.innerText(), /210-450-4800/, 'every answer ends with the help desk');

    // Citation numbers in the answer, and the source cards under it.
    const cites = answer.locator('a.bc-cite');
    assert.ok(await cites.count() >= 1, 'the answer has citation numbers');
    const sources = turn.locator('.bc-src');
    assert.ok(await sources.count() >= 1, 'sources are listed under the answer');
    const firstTitle = await sources.first().locator('b').innerText();
    assert.ok(firstTitle.length > 0);

    // A citation points at its source: same address as the matching card.
    const n = await cites.first().innerText();
    const card = turn.locator('.bc-src', { has: page.locator('.bc-src-n', { hasText: new RegExp(`^${n}$`) }) }).first();
    assert.equal(await cites.first().getAttribute('href'), await card.getAttribute('href'));

    // Answer controls.
    for (const name of ['Helpful', 'Not helpful', 'Copy answer']) await turn.getByRole('button', { name, exact: true }).waitFor();
    await turn.getByRole('button', { name: 'Shorter' }).waitFor();
    await turn.getByRole('button', { name: 'More detail' }).waitFor();

    // Thumbs up: saved on the server, and the comment box opens.
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/feedback') && r.ok());
    await turn.getByRole('button', { name: 'Helpful', exact: true }).click();
    await saved;
    await turn.getByLabel('Your feedback').waitFor();
    const [conv] = (await historyOf(srv.url, 'e2e-asker')).conversations;
    const { turns } = await historyOf(srv.url, 'e2e-asker', conv.conversationId);
    assert.equal(turns[0].question, 'Where are the Abridge tip sheets?');
    assert.equal(turns[0].feedback, 1);
    await context.close();
  });

  test('a citation to a site page opens that page, and the conversation is still there', async () => {
    await createUser(srv.url, 'e2e-citation');
    const context = await contextFor(browser, srv.url, 'e2e-citation');
    const page = await context.newPage();
    await openPane(page);

    const turn = await ask(page, 'What is Haiku?');
    // A citation to a page (not a downloadable file) stays in the replica.
    const local = turn.locator(`.bc-answer a.bc-cite[href^="/sites/BetterCare/"]:not([target])`).first();
    assert.ok(await local.count(), 'at least one citation links to a page on the site');
    const href = await local.getAttribute('href');
    await Promise.all([page.waitForURL((u) => u.pathname === new URL(href, srv.url).pathname), local.click()]);
    assert.notEqual(new URL(page.url()).pathname, HOME);

    // The pane reopens on the new page with the same conversation.
    await page.locator('.bc-pane .bc-turn--user', { hasText: 'What is Haiku?' }).waitFor();
    await context.close();
  });

  test('an off-topic question gets the fixed reply and the help desk line', async () => {
    await createUser(srv.url, 'e2e-offtopic');
    const context = await contextFor(browser, srv.url, 'e2e-offtopic');
    const page = await context.newPage();
    await openPane(page);

    const turn = await ask(page, 'What is the best recipe for chocolate chip cookies?');
    const text = await turn.locator('.bc-answer').innerText();
    assert.match(text, /That information doesn't exist in the BetterCare documents/);
    assert.match(text, /Health IT Help Desk at 210-450-4800/);
    assert.doesNotMatch(text, /Here's what I found/);
    await context.close();
  });

  test('New conversation clears the thread and shows the welcome', async () => {
    await createUser(srv.url, 'e2e-reset');
    const context = await contextFor(browser, srv.url, 'e2e-reset');
    const page = await context.newPage();
    const pane = await openPane(page);

    await ask(page, 'Where are the Abridge tip sheets?');
    assert.equal(await pane.locator('.bc-turn--user').count(), 1);
    await pane.getByRole('button', { name: 'New conversation' }).click();
    await pane.locator('.bc-welcome').waitFor();
    assert.equal(await pane.locator('.bc-turn').count(), 0, 'no questions or answers left in the thread');

    // The next question starts a second conversation in the history.
    await ask(page, 'How do I contact the help desk?');
    const { conversations } = await historyOf(srv.url, 'e2e-reset');
    assert.equal(conversations.length, 2);
    await context.close();
  });
});
