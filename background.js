// Background service worker: owns the context menu and the keyboard command,
// and relays "highlight" / "remove" messages between the popup and the
// content script running in the active tab.

const MENU_ID = "highlight-this";

function isGmailUrl(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === "mail.google.com" || host.endsWith(".mail.google.com");
  } catch (e) {
    return false;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Highlight this",
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || tab.id == null) return;
  if (isGmailUrl(tab.url)) return;
  chrome.tabs.sendMessage(tab.id, { type: "HIGHLIGHT_SELECTION" });
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "highlight-selection") return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || tab.id == null || isGmailUrl(tab.url)) return;
    chrome.tabs.sendMessage(tab.id, { type: "HIGHLIGHT_SELECTION" });
  });
});

// Popup cannot talk to the content script of the active tab on its own
// (it does not know the tab id ahead of time), so it goes through here.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === "GET_HIGHLIGHTS_REQUEST") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab || tab.id == null) {
        sendResponse({ highlights: [], pageKey: null });
        return;
      }
      if (isGmailUrl(tab.url)) {
        sendResponse({ highlights: [], pageKey: null, excluded: true });
        return;
      }
      chrome.tabs.sendMessage(
        tab.id,
        { type: "GET_HIGHLIGHTS" },
        (response) => {
          if (chrome.runtime.lastError || !response) {
            sendResponse({ highlights: [], pageKey: null });
            return;
          }
          sendResponse(response);
        }
      );
    });
    return true; // keep the message channel open for the async response
  }

  if (message && message.type === "REMOVE_HIGHLIGHT_REQUEST" && message.id) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab && tab.id != null) {
        chrome.tabs.sendMessage(tab.id, {
          type: "REMOVE_HIGHLIGHT",
          id: message.id,
        });
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  return undefined;
});
