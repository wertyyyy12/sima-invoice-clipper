let lastRightClickedEl = null;
let isMacroRecording = false;

document.addEventListener(
  "contextmenu",
  (event) => {
    const target = event.target;
    if (target instanceof Element) {
      lastRightClickedEl = target;
    }
  },
  true
);

document.addEventListener(
  "click",
  (event) => {
    if (!isMacroRecording || !event.isTrusted || event.button !== 0) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const selector = getElementSelector(target);
    if (!selector) {
      return;
    }
    chrome.runtime.sendMessage({
      action: "macro-record-click",
      selector,
    });
  },
  true
);

function cssEscape(value) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
}

function canTargetElement(el) {
  if (!(el instanceof Element)) {
    return false;
  }
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

function getElementSelector(el) {
  if (!(el instanceof Element)) {
    return null;
  }

  if (el.id) {
    const idSelector = `#${cssEscape(el.id)}`;
    if (document.querySelector(idSelector) === el) {
      return idSelector;
    }
  }

  const preferredAttrs = ["data-testid", "data-test", "name", "aria-label"];
  for (const attr of preferredAttrs) {
    const value = el.getAttribute(attr);
    if (!value) continue;
    const selector = `[${attr}="${cssEscape(value)}"]`;
    if (document.querySelector(selector) === el) {
      return selector;
    }
  }

  const parts = [];
  let current = el;
  while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 7) {
    let segment = current.tagName.toLowerCase();
    if (!segment) break;

    if (current.id) {
      const idSelector = `#${cssEscape(current.id)}`;
      if (document.querySelector(idSelector) === current) {
        parts.unshift(idSelector);
        break;
      }
    }

    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (child) => child.tagName === current.tagName
      );
      if (siblings.length > 1) {
        const index = siblings.indexOf(current);
        segment += `:nth-of-type(${index + 1})`;
      }
    }

    parts.unshift(segment);
    current = parent;
  }

  if (!parts.length) {
    return null;
  }

  const selector = parts.join(" > ");
  return document.querySelector(selector) ? selector : null;
}

function replaceTextInElement(el, value) {
  if (!canTargetElement(el)) {
    return false;
  }

  el.focus();

  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
    el.select();
  } else if (el.isContentEditable) {
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  if (document.execCommand("insertText", false, value)) {
    return true;
  }

  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
    const proto =
      el.tagName === "INPUT"
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  if (el.isContentEditable) {
    el.textContent = value;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  return false;
}

function sleep(ms) {
  if (!ms || ms < 1) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runTemplateMacro(steps, fieldValues) {
  let executedSteps = 0;
  let skippedSteps = 0;

  for (const step of steps) {
    await sleep(step.delayMs);

    if (step.type === "click") {
      const el = typeof step.selector === "string" ? document.querySelector(step.selector) : null;
      if (!(el instanceof HTMLElement)) {
        skippedSteps += 1;
        continue;
      }
      el.scrollIntoView({ block: "center", inline: "center" });
      el.click();
      executedSteps += 1;
      continue;
    }

    if (step.type === "pasteField") {
      const el = typeof step.selector === "string" ? document.querySelector(step.selector) : null;
      const rawValue = fieldValues?.[step.fieldLabel];
      if (!canTargetElement(el) || rawValue == null) {
        skippedSteps += 1;
        continue;
      }
      replaceTextInElement(el, String(rawValue));
      executedSteps += 1;
      continue;
    }

    skippedSteps += 1;
  }

  return {
    ok: true,
    executedSteps,
    skippedSteps,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "macro-ping") {
    sendResponse({ ok: true });
    return false;
  }

  if (message.action === "start-macro-recording") {
    isMacroRecording = true;
    sendResponse({ ok: true });
    return false;
  }

  if (message.action === "stop-macro-recording") {
    isMacroRecording = false;
    sendResponse({ ok: true });
    return false;
  }

  if (message.action === "paste-field-value" && message.value != null) {
    const el = canTargetElement(lastRightClickedEl) ? lastRightClickedEl : null;
    if (!el) {
      sendResponse({ ok: false, error: "No editable target found for paste." });
      return false;
    }

    const success = replaceTextInElement(el, String(message.value));
    sendResponse({
      ok: success,
      selector: getElementSelector(el),
    });
    return false;
  }

  if (message.action === "run-template-macro") {
    runTemplateMacro(message.steps || [], message.fieldValues || {})
      .then(sendResponse)
      .catch((error) => {
        sendResponse({ ok: false, error: error?.message || String(error) });
      });
    return true;
  }

  return false;
});
