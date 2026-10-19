// Covers: The Clinical IT admin panel in a real browser: an admin sees how many questions were asked, and someone who isn't an admin is asked to sign in as one.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, missingPrereq } from './server.mjs';
import { launch, contextFor, createUser } from './browser.mjs';

const skip = await missingPrereq();

describe('admin panel', { skip: skip || false }, () => {
  let srv, browser;
  before(async () => {
    // Admins can only be made in the database (there's no API for it).
    srv = await startServer({ seed: (store) => store.saveUser('e2e-admin', { name: 'Ada Admin', role: 'it', isAdmin: true }) });
    browser = await launch();
    // Two questions asked by someone else, through the API.
    await createUser(srv.url, 'e2e-staff');
    for (const q of ['Where are the Abridge tip sheets?', 'How do I contact the help desk?']) {
      const r = await fetch(`${srv.url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sophia-User': 'e2e-staff' },
        body: JSON.stringify({ messages: [{ role: 'user', content: q }], conversationId: `c-${q.length}` }),
      });
      await r.text();
    }
  });
  after(async () => { await browser?.close(); await srv?.stop(); });

  test('an admin sees the question count and the recent questions', async () => {
    const context = await contextFor(browser, srv.url, 'e2e-admin');
    const page = await context.newPage();
    await page.goto('/admin');
    const questions = page.locator('.kpi', { has: page.locator('.l', { hasText: /^Questions$/ }) });
    await questions.waitFor();
    assert.equal(await questions.locator('.v').innerText(), '2');
    await page.getByText('Signed in as e2e-admin').waitFor();
    await page.getByText('Where are the Abridge tip sheets?').first().waitFor();
    await context.close();
  });

  test('someone who is not an admin is asked to sign in as one', async () => {
    const context = await contextFor(browser, srv.url, 'e2e-staff');
    const page = await context.newPage();
    await page.goto('/admin');
    await page.getByRole('heading', { name: 'Sign in as an admin' }).waitFor();
    await page.getByText("e2e-staff isn't an admin.", { exact: false }).waitFor();
    assert.equal(await page.locator('.kpi').count(), 0, 'no numbers are shown');
    await context.close();
  });
});
