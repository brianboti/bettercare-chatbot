// Injects a launcher button on the BetterCare site.
//
// Read-only: it adds one button to the page in this browser and never reads,
// submits, or alters anything on the site. Unloading the extension removes it.

(() => {
  if (document.getElementById('bc-assistant-launcher')) return;

  const btn = document.createElement('button');
  btn.id = 'bc-assistant-launcher';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Open Sophia Assistant');
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>
    </svg>
    <span>Ask Sophia</span>`;

  const hint = document.createElement('div');
  hint.id = 'bc-assistant-hint';
  hint.hidden = true;

  btn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'open-panel' }, (res) => {
      // Chrome only lets the panel open from a user gesture. If that didn't
      // survive the hop to the service worker, say what to do instead.
      if (chrome.runtime.lastError || !res?.ok) {
        hint.textContent = 'Click the Sophia icon in the toolbar to open the panel.';
        hint.hidden = false;
        setTimeout(() => { hint.hidden = true; }, 5000);
      }
    });
  });

  document.body.append(btn, hint);
})();
