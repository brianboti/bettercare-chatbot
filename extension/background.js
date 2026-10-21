// Service worker. Opens the side panel, and nothing else.
//
// The network requests are the side panel's (questions to the Sophia server,
// and "who is signed in" to SharePoint) and launcher.js's (the same
// SharePoint question). Nothing here talks to anything.

// Clicking the toolbar icon opens the panel on any tab.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn('[Sophia] setPanelBehavior:', err));
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
