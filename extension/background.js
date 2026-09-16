// Service worker. Opens the side panel, and nothing else.
//
// This extension never contacts SharePoint. It reads no page content and sends
// no network requests of any kind — the corpus it searches is bundled locally
// in data/corpus.json.

// Clicking the toolbar icon opens the panel on any tab.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn('[BetterCare] setPanelBehavior:', err));
});

// The on-page launcher asks us to open the panel. `sidePanel.open()` requires a
// user gesture, which a click in the content script carries through to here.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'open-panel') return;

  const tabId = sender.tab?.id;
  if (tabId == null) {
    sendResponse({ ok: false, error: 'no tab' });
    return;
  }

  chrome.sidePanel
    .open({ tabId })
    .then(() => sendResponse({ ok: true }))
    .catch((err) => sendResponse({ ok: false, error: String(err) }));

  return true; // keep the message channel open for the async response
});
