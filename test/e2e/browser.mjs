// Browser helpers for the end-to-end tests: one headless Chromium per test
// file, a fresh context (empty storage) per journey, and the steps a person
// takes in the Sophia pane.

import { chromium } from 'playwright';

export const HOME = '/sites/BetterCare/SitePages/Home.aspx';

export const launch = () => chromium.launch();

/** A new browser context signed in as `userId` (the demo sign-in is localStorage 'sophia-user'). */
export async function contextFor(browser, baseURL, userId) {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  await context.addInitScript((id) => {
    try { localStorage.setItem('sophia-user', JSON.stringify({ id })); } catch { /* ignore */ }
  }, userId);
  return context;
}

/** Create a person with a role through the API, so the pane skips the introduction. */
export async function createUser(baseURL, id, { name = 'Pat Example', role = 'nurse' } = {}) {
  const r = await fetch(`${baseURL}/api/me`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sophia-User': id },
    body: JSON.stringify({ name, role }),
  });
  if (!r.ok) throw new Error(`could not create ${id}: ${r.status}`);
}

/** Server-side history for a person. */
export async function historyOf(baseURL, id, conversationId = null) {
  const path = conversationId ? `/api/history/${encodeURIComponent(conversationId)}` : '/api/history';
  return (await fetch(`${baseURL}${path}`, { headers: { 'X-Sophia-User': id } })).json();
}

/** Open the BetterCare home page and the Sophia pane. */
export async function openPane(page) {
  await page.goto(HOME);
  await page.locator('.bc-launcher').click();
  await page.locator('html[data-bc-pane-open]').waitFor();
  return page.locator('.bc-pane');
}

/** Type a question, send it, and wait until the answer has finished. Returns the answer's turn. */
export async function ask(page, question) {
  const pane = page.locator('.bc-pane');
  const before = await pane.locator('.bc-turn--user').count();
  await pane.getByLabel('Ask Sophia', { exact: true }).fill(question);
  await pane.getByLabel('Ask Sophia', { exact: true }).press('Enter');
  await pane.locator('.bc-turn--user').nth(before).waitFor();
  // The thumbs appear only once the answer is complete and saved.
  const turn = pane.locator('.bc-turn:not(.bc-turn--user)').last();
  await turn.locator('.bc-actions').waitFor({ timeout: 30_000 });
  return turn;
}
