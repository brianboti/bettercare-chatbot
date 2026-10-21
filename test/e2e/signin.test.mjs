// Covers: Signing in, the way it works when deployed (AUTH_MODE=password): the website sends you to the sign-in page and back, then Sign out; the Chrome extension signs you in from SharePoint, or with a username and password.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer, missingPrereq, ROOT } from './server.mjs';
import { launch, HOME } from './browser.mjs';
import { CURRENT_USER } from '../../extension/lib/sharepoint.js';

const skip = await missingPrereq();
const ADMIN_PASSWORD = 'e2e-admin-password';
const ENV = {
  AUTH_MODE: 'password', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD,
  ALLOW_SIGNUP: '1', SHAREPOINT_SIGNIN: '1', SHAREPOINT_EMAIL_DOMAINS: 'uthscsa.edu',
};

describe('signing in', { skip: skip || false }, () => {
  let srv, browser;
  before(async () => { srv = await startServer({ env: ENV }); browser = await launch(); });
  after(async () => { await browser?.close(); await srv?.stop(); });

  test('website: the sign-in page, back to the page you wanted, then Sign out', async () => {
    const context = await browser.newContext({ baseURL: srv.url, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    await page.goto(HOME);
    await page.waitForURL(/\/signin\?next=/);
    await page.getByLabel('Username').fill('admin');
    await page.getByLabel('Password').fill('not the password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('alert').filter({ hasText: "don't match" }).waitFor();

    // Create an account instead.
    await page.getByRole('button', { name: 'Create an account' }).click();
    await page.getByLabel('Your name').fill('Pat Example');
    await page.getByLabel('Username').fill('pat.example');
    await page.getByLabel('Password').fill('pat-example-pw');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.waitForURL((u) => u.pathname === HOME);

    // Signed in: the pane works with the session cookie alone.
    await page.evaluate(() => fetch('/api/me', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'nurse' }) }));
    await page.reload();
    await page.locator('.bc-launcher').click();
    const pane = page.locator('.bc-pane');
    await pane.getByLabel('Ask Sophia', { exact: true }).fill('Where are the Abridge tip sheets?');
    await pane.getByLabel('Ask Sophia', { exact: true }).press('Enter');
    await pane.locator('.bc-turn:not(.bc-turn--user) .bc-actions').waitFor({ timeout: 30_000 });

    // The suite bar shows who; Sign out goes back to the sign-in page.
    await page.locator('.bc-user-btn').click();
    await page.locator('.bc-usermenu').getByText('Pat Example').waitFor();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await page.waitForURL(/\/signin/);
    await page.goto(HOME);
    await page.waitForURL(/\/signin\?next=/);
    await context.close();
  });

  test('extension: signs in from SharePoint on its own; after Sign out, a password works too', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'sophia-ext-'));
    const ext = join(ROOT, 'extension');
    // Extensions need Chromium's new headless mode (channel "chromium").
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    });
    try {
      // SharePoint, as the extension sees it: Jane is signed in there.
      await context.route(CURRENT_USER, (route) => route.fulfill({ json: { Email: 'Jane.Doe@uthscsa.edu', Title: 'Jane Doe', LoginName: 'i:0#.f|membership|jane.doe@uthscsa.edu' } }));
      let [worker] = context.serviceWorkers();
      worker ??= await context.waitForEvent('serviceworker');
      const id = new URL(worker.url()).host;

      const page = await context.newPage();
      await page.goto(`chrome-extension://${id}/sidepanel.html`);
      await page.evaluate((apiUrl) => chrome.storage.local.set({ apiUrl }), srv.url);
      await page.reload();

      // Connected and signed in as Jane without being asked.
      await page.locator('#scope[data-state="retrieval-only"]').waitFor();
      await page.locator('#q').fill('Where are the Abridge tip sheets?');
      await page.locator('#q').press('Enter');
      await page.locator('.turn .answer').last().waitFor();
      await page.locator('.sources').last().waitFor({ timeout: 30_000 });
      const me = await page.evaluate(async (api) => {
        const { sessions } = await chrome.storage.local.get('sessions');
        return (await fetch(`${api}/api/me`, { headers: { Authorization: `Bearer ${sessions[api].token}` } })).json();
      }, srv.url);
      assert.deepEqual([me.user.id, me.signedInWith], ['jane.doe@uthscsa.edu', 'sharepoint']);

      // Settings shows the account; Sign out brings up the sign-in form.
      await page.locator('#settings-btn').click();
      await page.locator('#account').getByText('Signed in as Jane Doe (from SharePoint)').waitFor();
      await page.locator('#account').getByRole('button', { name: 'Sign out' }).click();
      await page.getByRole('heading', { name: 'Sign in to Sophia' }).waitFor();

      await page.getByLabel('Username').fill('admin');
      await page.getByLabel('Password').fill(ADMIN_PASSWORD);
      await page.locator('form.signin').getByRole('button', { name: 'Sign in' }).click();
      await page.locator('.welcome').waitFor();
      // Settings is still open from signing out.
      await page.locator('#account').getByText('Signed in as Administrator').waitFor();
    } finally {
      await context.close();
      rmSync(profile, { recursive: true, force: true });
    }
  });
});
