import * as pdfjsLib from "./pdf.mjs";

let workerInitialized = false;

export function ensurePdfWorker(runtimePdfjsLib = pdfjsLib) {
  if (workerInitialized && runtimePdfjsLib.GlobalWorkerOptions.workerSrc) {
    return;
  }
  runtimePdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.mjs");
  workerInitialized = true;
}

export const initPdfWorker = ensurePdfWorker;

export async function readFileAsArrayBuffer(file) {
  return file.arrayBuffer();
}

export async function loadPdfFromArrayBuffer(arrayBuffer, runtimePdfjsLib = pdfjsLib) {
  ensurePdfWorker(runtimePdfjsLib);
  const loadingTask = runtimePdfjsLib.getDocument({ data: arrayBuffer });
  return loadingTask.promise;
}

export function createTemplateId() {
  return `tpl_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

export function normalizeRect(rect, pageWidth, pageHeight) {
  if (!pageWidth || !pageHeight) {
    throw new Error("Page dimensions are required to normalize a rectangle.");
  }

  return {
    x: rect.x / pageWidth,
    y: rect.y / pageHeight,
    width: rect.width / pageWidth,
    height: rect.height / pageHeight
  };
}

export function denormalizeRect(rect, pageWidth, pageHeight) {
  return {
    x: rect.x * pageWidth,
    y: rect.y * pageHeight,
    width: rect.width * pageWidth,
    height: rect.height * pageHeight
  };
}

export function resolveFieldRect(field, pageWidth, pageHeight, template = null) {
  if (!field?.rect) {
    return null;
  }

  const rect = field.rect;

  const appearsNormalized =
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x <= 1 &&
    rect.y <= 1 &&
    rect.width <= 1 &&
    rect.height <= 1;

  if (appearsNormalized) {
    return denormalizeRect(rect, pageWidth, pageHeight);
  }

  if (template?.pageWidth && template?.pageHeight) {
    return {
      x: (rect.x / template.pageWidth) * pageWidth,
      y: (rect.y / template.pageHeight) * pageHeight,
      width: (rect.width / template.pageWidth) * pageWidth,
      height: (rect.height / template.pageHeight) * pageHeight
    };
  }

  return rect;
}

function clampRect(rect, maxWidth, maxHeight) {
  const x = Math.max(0, Math.min(rect.x, maxWidth));
  const y = Math.max(0, Math.min(rect.y, maxHeight));
  const right = Math.max(x, Math.min(rect.x + rect.width, maxWidth));
  const bottom = Math.max(y, Math.min(rect.y + rect.height, maxHeight));

  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y)
  };
}

function rectsOverlap(a, b) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function compareTextItems(a, b) {
  const lineTolerance = Math.max(3, Math.min(a.height, b.height) * 0.5);
  if (Math.abs(a.y - b.y) > lineTolerance) {
    return a.y - b.y;
  }
  return a.x - b.x;
}

function joinTextItems(items) {
  if (!items.length) {
    return "";
  }

  let value = items[0].str;

  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1];
    const current = items[index];

    const isNewLine =
      Math.abs(previous.y - current.y) >
      Math.max(3, Math.min(previous.height, current.height) * 0.5);
    if (isNewLine || previous.hasEOL) {
      value += "\n";
      value += current.str;
      continue;
    }

    const gap = current.x - previous.right;
    const needsSpace =
      gap > 2 &&
      !value.endsWith(" ") &&
      !/^[,.;:!?%\])]/.test(current.str) &&
      !/[\/$([#-]$/.test(previous.str);

    if (needsSpace) {
      value += " ";
    }

    value += current.str;
  }

  return value.replace(/[ \t]+\n/g, "\n").trim();
}

export async function getPageTextItems(page) {
  const viewport = page.getViewport({ scale: 1 });
  const textContent = await page.getTextContent();

  const textItems = textContent.items
    .map((item, index) => {
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const width = typeof item.width === "number" ? item.width : Math.hypot(tx[0], tx[1]);
      const height = Math.max(Math.abs(item.height || 0), Math.hypot(tx[2], tx[3]) || 0);

      if (!item.str || width <= 0 || height <= 0) {
        return null;
      }

      const x = tx[4];
      const y = tx[5] - height;

      return {
        id: `${index}`,
        str: item.str,
        hasEOL: Boolean(item.hasEOL),
        x,
        y,
        width,
        height,
        right: x + width,
        bottom: y + height
      };
    })
    .filter(Boolean);

  return {
    pageWidth: viewport.width,
    pageHeight: viewport.height,
    textItems
  };
}

export function extractTextFromRect(textItems, rect, pageWidth, pageHeight) {
  if (!rect || !Array.isArray(textItems)) {
    return "";
  }

  const normalizedRect =
    typeof pageWidth === "number" && typeof pageHeight === "number"
      ? clampRect(rect, pageWidth, pageHeight)
      : rect;

  const matches = textItems
    .filter((item) => rectsOverlap(item, normalizedRect))
    .sort(compareTextItems);

  return joinTextItems(matches);
}

export async function extractFieldsFromPdf(arrayBuffer, template) {
  const document = await loadPdfFromArrayBuffer(arrayBuffer);
  const pageCache = new Map();
  const fields = [];

  for (const field of template.fields ?? []) {
    const pageNumber = Math.min(document.numPages, Math.max(1, field.page || 1));

    if (!pageCache.has(pageNumber)) {
      const page = await document.getPage(pageNumber);
      pageCache.set(pageNumber, await getPageTextItems(page));
    }

    const pageData = pageCache.get(pageNumber);
    const resolvedRect = resolveFieldRect(field, pageData.pageWidth, pageData.pageHeight, template);
    const value = extractTextFromRect(
      pageData.textItems,
      resolvedRect,
      pageData.pageWidth,
      pageData.pageHeight
    );

    fields.push({
      id: field.id,
      label: field.label,
      page: pageNumber,
      value,
      isEmpty: value.length === 0
    });
  }

  const hasAnyText = [...pageCache.values()].some((pageData) => pageData.textItems.length > 0);

  return {
    fields,
    hasAnyText
  };
}

export async function extractAllFields(pdfDoc, template) {
  const pageCache = new Map();
  const results = [];

  for (const field of template.fields ?? []) {
    const pageNumber = Math.min(pdfDoc.numPages, Math.max(1, field.page || 1));

    if (!pageCache.has(pageNumber)) {
      const page = await pdfDoc.getPage(pageNumber);
      pageCache.set(pageNumber, await getPageTextItems(page));
    }

    const pageData = pageCache.get(pageNumber);
    const resolvedRect = resolveFieldRect(field, pageData.pageWidth, pageData.pageHeight, template);
    const value = extractTextFromRect(
      pageData.textItems,
      resolvedRect,
      pageData.pageWidth,
      pageData.pageHeight
    );

    results.push({
      label: field.label,
      value,
      found: value.length > 0
    });
  }

  return results;
}

export function canvasRectToPdfRect(canvasRect, scale) {
  return {
    x: canvasRect.x / scale,
    y: canvasRect.y / scale,
    width: canvasRect.width / scale,
    height: canvasRect.height / scale
  };
}

export function pdfRectToCanvasRect(pdfRect, scale) {
  return {
    x: pdfRect.x * scale,
    y: pdfRect.y * scale,
    width: pdfRect.width * scale,
    height: pdfRect.height * scale
  };
}
