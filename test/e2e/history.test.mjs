// Covers: A person's question history in a real browser: past questions listed by day, reopening one, removing one, and clearing them all.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, missingPrereq } from './server.mjs';
import { launch, contextFor, createUser, historyOf, openPane, ask } from './browser.mjs';

const skip = await missingPrereq();

describe('question history', { skip: skip || false }, () => {
  let srv, browser;
  before(async () => { srv = await startServer(); browser = await launch(); });
  after(async () => { await browser?.close(); await srv?.stop(); });

  test('list, reopen, remove one, then clear all', async () => {
    const id = 'e2e-history';
    await createUser(srv.url, id);
    const context = await contextFor(browser, srv.url, id);
    const page = await context.newPage();
    const pane = await openPane(page);

    // Two conversations.
    await ask(page, 'Where are the Abridge tip sheets?');
    await pane.getByRole('button', { name: 'New conversation' }).click();
    await ask(page, 'How do I contact the help desk?');
    await pane.getByRole('button', { name: 'New conversation' }).click();

    // History lists both, newest first, under "Today".
    await pane.getByRole('button', { name: 'History' }).click();
    const rows = pane.locator('.bc-history-row');
    await rows.nth(1).waitFor();
    assert.deepEqual(await pane.locator('.bc-history h4').allInnerTexts(), ['TODAY']);
    assert.deepEqual(await rows.locator('.bc-history-item > span').allInnerTexts(), ['How do I contact the help desk?', 'Where are the Abridge tip sheets?']);

    // Reopen the older one: its question and answer come back.
    await rows.nth(1).locator('.bc-history-item').click();
    await pane.locator('.bc-turn--user', { hasText: 'Where are the Abridge tip sheets?' }).waitFor();
    assert.match(await pane.locator('.bc-answer').first().innerText(), /Abridge/);

    // Remove the newer one with its ×.
    await pane.getByRole('button', { name: 'History' }).click();
    await rows.nth(1).waitFor();
    const newer = rows.filter({ hasText: 'How do I contact the help desk?' });
    await newer.hover();
    await newer.getByRole('button', { name: /^Remove from history/ }).click();
    await newer.waitFor({ state: 'detached' });
    assert.equal(await rows.count(), 1);
    assert.deepEqual((await historyOf(srv.url, id)).conversations.map((c) => c.title), ['Where are the Abridge tip sheets?']);

    // Clear all asks first, in place; Cancel keeps everything.
    await pane.getByRole('button', { name: 'Clear all' }).click();
    await pane.getByText('Remove every question?').waitFor();
    await pane.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await rows.count(), 1);

    // Then Remove all empties the list. The open conversation was one of
    // them, so the thread starts over.
    await pane.getByRole('button', { name: 'Clear all' }).click();
    await pane.getByRole('button', { name: 'Remove all' }).click();
    await pane.getByText('Nothing yet.', { exact: false }).waitFor();
    assert.equal(await rows.count(), 0);
    assert.equal((await historyOf(srv.url, id)).conversations.length, 0);

    await pane.getByRole('button', { name: 'Back to the conversation' }).click();
    await pane.locator('.bc-welcome').waitFor();
    assert.equal(await pane.locator('.bc-turn--user').count(), 0);
    await context.close();
  });

  test("one person's history never shows another person's questions", async () => {
    await createUser(srv.url, 'e2e-alice');
    await createUser(srv.url, 'e2e-bob');
    const alice = await contextFor(browser, srv.url, 'e2e-alice');
    const page = await alice.newPage();
    await openPane(page);
    await ask(page, 'Where are the Abridge tip sheets?');
    await alice.close();

    const bob = await contextFor(browser, srv.url, 'e2e-bob');
    const bobPage = await bob.newPage();
    const pane = await openPane(bobPage);
    await pane.getByRole('button', { name: 'History' }).click();
    await pane.getByText('Nothing yet.', { exact: false }).waitFor();
    await bob.close();
  });
});
