const CONTEXT_MENU_FIELDS_KEY = "geminiContextMenuFields";
const ROOT_MENU_ID = "invoice-clipper-gemini";
const FIELD_MENU_PREFIX = "gemini-paste-field-";

let menuBuildPending = false;
let menuBuildRunning = false;

async function sendTabMessage(tabId, payload) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: true });
    });
  });
}

function formatFieldTitle(field, index) {
  const label = String(field?.label || field?.key || `field_${index + 1}`).trim();
  const value = String(field?.value || "").trim();
  const shortValue = value.length > 40 ? `${value.slice(0, 40)}…` : value;
  return `${label}: ${shortValue}`;
}

async function rebuildContextMenu() {
  if (menuBuildRunning) {
    menuBuildPending = true;
    return;
  }

  menuBuildRunning = true;
  menuBuildPending = false;

  try {
    await chrome.contextMenus.removeAll();

    const data = await chrome.storage.local.get(CONTEXT_MENU_FIELDS_KEY);
    const fields = Array.isArray(data[CONTEXT_MENU_FIELDS_KEY])
      ? data[CONTEXT_MENU_FIELDS_KEY]
      : [];

    if (!fields.length) {
      return;
    }

    chrome.contextMenus.create({
      id: ROOT_MENU_ID,
      title: "Invoice Clipper (Gemini)",
      contexts: ["editable"],
    });

    fields.forEach((field, index) => {
      const value = String(field?.value || "").trim();
      if (!value) {
        return;
      }

      chrome.contextMenus.create({
        id: `${FIELD_MENU_PREFIX}${index}`,
        parentId: ROOT_MENU_ID,
        title: formatFieldTitle(field, index),
        contexts: ["editable"],
      });
    });
  } finally {
    menuBuildRunning = false;
    if (menuBuildPending) {
      rebuildContextMenu();
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  rebuildContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  rebuildContextMenu();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "open-pdf-viewer") {
    let url = chrome.runtime.getURL("pdf-viewer/index.html");
    const params = new URLSearchParams();
    if (message.filename) params.set("filename", message.filename);
    url += `?${params.toString()}`;
    chrome.tabs.create({ url });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const match = String(info.menuItemId || "").match(/^gemini-paste-field-(\d+)$/);
  if (!match || !tab?.id) {
    return;
  }

  const index = Number.parseInt(match[1], 10);
  if (!Number.isFinite(index) || index < 0) {
    return;
  }

  const data = await chrome.storage.local.get(CONTEXT_MENU_FIELDS_KEY);
  const fields = Array.isArray(data[CONTEXT_MENU_FIELDS_KEY])
    ? data[CONTEXT_MENU_FIELDS_KEY]
    : [];
  const field = fields[index];
  const value = String(field?.value || "").trim();
  if (!value) {
    return;
  }

  await sendTabMessage(tab.id, {
    action: "paste-field-value",
    value,
  });
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes[CONTEXT_MENU_FIELDS_KEY]) {
    rebuildContextMenu();
  }
});
