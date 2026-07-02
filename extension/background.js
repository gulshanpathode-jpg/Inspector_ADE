// background.js - service worker (MV3)

// Open the side panel when the toolbar icon is clicked.
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.windowId != null) {
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    } catch (e) {
      console.error("Failed to open side panel:", e);
    }
  }
});

// Make the side panel available on all tabs.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.error(e));
});

// On-demand content-script injection.
//
// The side panel calls this whenever a message to content.js fails - typically
// because the inspection page was open BEFORE the extension was (re)loaded, so
// the manifest-declared content script never ran on it. Injecting here (then the
// panel retries its message) removes the "reload the page first" requirement.
//
// content.js guards against double-injection, so it's safe to run even if the
// manifest match already loaded it.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "ENSURE_CONTENT_SCRIPT" && msg.tabId != null) {
    chrome.scripting
      .executeScript({ target: { tabId: msg.tabId }, files: ["imageModal.js", "content.js"] })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // keep the message channel open for the async response
  }
});
