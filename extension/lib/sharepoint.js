// Who is signed in to SharePoint, for the extension's SharePoint sign-in.
//
// SharePoint answers GET /_api/web/currentuser for whoever's browser asks,
// using that browser's own SharePoint sign-in. Two places ask:
//   - launcher.js, on BetterCare pages (same origin, so the cookie always
//     goes along), saves the answer in chrome.storage.local as `spUser`
//   - the side panel asks directly when nothing fresh is saved
// Read-only: one GET, nothing on SharePoint changes.
//
// The Sophia server can't verify this answer (the extension could say
// anything), which is why the server only accepts it with SHAREPOINT_SIGNIN=1.

export const SITE = 'https://uthealthsa.sharepoint.com/sites/BetterCare';
export const CURRENT_USER = `${SITE}/_api/web/currentuser`;
export const MAX_AGE_MS = 12 * 3600_000;

/**
 * { email, name } from a currentuser response, or null.
 * The email is Email, else UserPrincipalName, else the end of the claims
 * login name ("i:0#.f|membership|jane.doe@uthscsa.edu").
 */
export function spIdentity(json) {
  if (!json || typeof json !== 'object') return null;
  const fromLogin = String(json.LoginName || '').split('|').pop();
  const email = [json.Email, json.UserPrincipalName, fromLogin]
    .map((x) => String(x || '').trim().toLowerCase())
    .find((x) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(x));
  if (!email) return null;
  const name = String(json.Title || '').trim() || null;
  return { email, name };
}

/** A saved spUser entry, if it is recent enough to trust. */
export function freshSaved(saved, now = Date.now()) {
  if (!saved?.at || now - saved.at > MAX_AGE_MS) return null;
  return spIdentity(saved.user);
}

/** Ask SharePoint directly. Null when not signed in there (or unreachable). */
export async function fetchSharePointUser(fetchFn = fetch) {
  try {
    const res = await fetchFn(CURRENT_USER, { credentials: 'include', headers: { Accept: 'application/json;odata=nometadata' } });
    if (!res.ok) return null;
    return spIdentity(await res.json());
  } catch {
    return null;
  }
}
