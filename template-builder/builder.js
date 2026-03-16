import * as pdfjsLib from "../lib/pdf.mjs";
import {
  ensurePdfWorker,
  extractTextFromRect,
  getPageTextItems,
  normalizeRect,
  resolveFieldRect,
  canvasRectToPdfRect,
  pdfRectToCanvasRect,
} from "../lib/extractor.js";
import {
  getTemplateSamplePdf,
  loadTemplates,
  saveTemplateSamplePdf,
  upsertTemplate,
} from "../lib/storage.js";

ensurePdfWorker(pdfjsLib);

// ── State ──
let pdfDoc = null;
let currentPage = 1;
let currentPageData = null;
let viewportScale = 1;
let pageHeight = 0;
let fitScale = 1;
let zoomFactor = 1;

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.1;

let templateId = null;
let templateCreatedAt = null;
let templatePageWidth = null;
let templatePageHeight = null;
let templateSamplePdf = null; // { name, mimeType, dataUrl }
let existingTemplate = null;
let fields = []; // {id, label, rect (normalized or absolute), page, sampleValue}
let drawingFieldId = null; // set when redrawing an existing field
let isDrawing = false;
let drawStart = null;
let pendingRect = null; // { normalizedRect, page, sampleValue } — awaiting a name

function clearPendingRect() {
  pendingRect = null;
  newFieldLabelInput.value = "";
  newFieldLabelInput.placeholder = "Field label (e.g. Ref #)";
  addFieldBtn.textContent = "+ Add Field";
  cancelPendingBtn.hidden = true;
}

// Field colors (cycling)
const FIELD_COLORS = [
  "#4263eb",
  "#e03131",
  "#2b8a3e",
  "#e8590c",
  "#9c36b5",
  "#1098ad",
  "#d6336c",
  "#f08c00",
];

// ── Setup screen DOM refs ──
const setupOverlay = document.getElementById("setupOverlay");
const setupNameInput = document.getElementById("setupName");
const setupPdfFileInput = document.getElementById("setupPdfFile");
const setupDropzone = document.getElementById("setupDropzone");
const setupDropzoneText = document.getElementById("setupDropzoneText");
const setupContinueBtn = document.getElementById("setupContinueBtn");
let setupPdfFile = null;

// ── DOM refs ──
const pdfFileInput = document.getElementById("pdfFile");
const uploadText = document.getElementById("uploadText");
const pageNav = document.getElementById("pageNav");
const prevPageBtn = document.getElementById("prevPage");
const nextPageBtn = document.getElementById("nextPage");
const pageInfo = document.getElementById("pageInfo");
const zoomControls = document.getElementById("zoomControls");
const zoomOutBtn = document.getElementById("zoomOut");
const zoomInBtn = document.getElementById("zoomIn");
const zoomFitBtn = document.getElementById("zoomFit");
const zoomValue = document.getElementById("zoomValue");
const pdfPageEl = document.getElementById("pdfPage");
const pdfCanvas = document.getElementById("pdfCanvas");
const overlayCanvas = document.getElementById("overlayCanvas");
const templateNameInput = document.getElementById("templateName");
const hint = document.getElementById("hint");
const fieldsSection = document.getElementById("fieldsSection");
const fieldsList = document.getElementById("fieldsList");
const addFieldRow = document.getElementById("addFieldRow");
const newFieldLabelInput = document.getElementById("newFieldLabel");
const addFieldBtn = document.getElementById("addFieldBtn");
const cancelPendingBtn = document.getElementById("cancelPendingBtn");
const drawingHint = document.getElementById("drawingHint");
const drawingFieldName = document.getElementById("drawingFieldName");
const cancelDrawingBtn = document.getElementById("cancelDrawing");
const cancelBtn = document.getElementById("cancelBtn");
const saveBtn = document.getElementById("saveBtn");

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("Failed to read sample PDF."));
    reader.readAsDataURL(file);
  });
}

function dataUrlToUint8Array(dataUrl) {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) {
    throw new Error("Invalid PDF data URL.");
  }
  const base64 = dataUrl.slice(commaIndex + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function cacheSamplePdfFile(file) {
  templateSamplePdf = {
    name: file.name,
    mimeType: file.type || "application/pdf",
    dataUrl: await fileToDataUrl(file),
  };
}

async function loadPdfIntoBuilder(arrayBuffer, fileName) {
  uploadText.textContent = fileName;
  pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  currentPage = 1;
  zoomFactor = 1;
  await renderPage(currentPage);

  pdfPageEl.style.display = "inline-block";
  fieldsSection.hidden = false;
  hint.textContent =
    "Draw a rectangle on the PDF around a value to add a field.";
  overlayCanvas.classList.add("drawing");

  updatePageNav();

  if (fields.length > 0) {
    await reExtractSampleValues();
    renderFieldsList();
  }
}

// ── Init ──
async function init() {
  const params = new URLSearchParams(window.location.search);
  templateId = params.get("templateId");

  if (templateId) {
    // Editing — skip setup screen
    setupOverlay.hidden = true;
    document.querySelector(".builder-panel h1").textContent = "Edit Template";
    const templates = await loadTemplates();
    const existing = templates.find((t) => t.id === templateId);
    if (existing) {
      existingTemplate = existing;
      templateNameInput.value = existing.name;
      templateCreatedAt = existing.created || null;
      templatePageWidth = existing.pageWidth || null;
      templatePageHeight = existing.pageHeight || null;
      fields = existing.fields.map((f) => ({
        id: crypto.randomUUID(),
        label: f.label,
        rect: f.rect,
        page: f.page || 1,
        sampleValue: "",
      }));
      renderFieldsList();
      updateSaveButton();

      const savedSamplePdf = await getTemplateSamplePdf(templateId);
      if (savedSamplePdf?.dataUrl) {
        templateSamplePdf = savedSamplePdf;
        try {
          const sampleBytes = dataUrlToUint8Array(savedSamplePdf.dataUrl);
          await loadPdfIntoBuilder(sampleBytes, savedSamplePdf.name || "Sample PDF");
        } catch (error) {
          console.error("Failed to load saved sample PDF", error);
          hint.textContent = "Could not load saved sample PDF. Upload one manually to continue.";
        }
      }
    }
  } else {
    // New template — show setup screen
    initSetupScreen();
  }
}

// ── PDF Loading ──
pdfFileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  await cacheSamplePdfFile(file);
  const arrayBuffer = await file.arrayBuffer();
  await loadPdfIntoBuilder(arrayBuffer, file.name);
});

async function renderPage(pageNum) {
  const page = await pdfDoc.getPage(pageNum);

  // Scale to fit viewer width (leave some padding)
  const viewerWidth =
    document.querySelector(".pdf-scroll").clientWidth - 32;
  const unscaledViewport = page.getViewport({ scale: 1 });
  fitScale = viewerWidth / unscaledViewport.width;
  viewportScale = fitScale * zoomFactor;
  pageHeight = unscaledViewport.height;

  const viewport = page.getViewport({ scale: viewportScale });

  // Setup PDF canvas
  pdfCanvas.width = viewport.width;
  pdfCanvas.height = viewport.height;
  pdfCanvas.style.width = viewport.width + "px";
  pdfCanvas.style.height = viewport.height + "px";

  // Setup overlay canvas to match
  overlayCanvas.width = viewport.width;
  overlayCanvas.height = viewport.height;
  overlayCanvas.style.width = viewport.width + "px";
  overlayCanvas.style.height = viewport.height + "px";

  // Render PDF
  const ctx = pdfCanvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;

  // Build text item geometry in the same coordinate system used by extraction.
  currentPageData = await getPageTextItems(page);
  pageHeight = currentPageData.pageHeight;

  // Redraw existing field rectangles on overlay
  redrawOverlay();
  updateZoomControls();
}

function updatePageNav() {
  if (!pdfDoc || pdfDoc.numPages <= 1) {
    pageNav.hidden = true;
    return;
  }
  pageNav.hidden = false;
  pageInfo.textContent = `Page ${currentPage} of ${pdfDoc.numPages}`;
  prevPageBtn.disabled = currentPage <= 1;
  nextPageBtn.disabled = currentPage >= pdfDoc.numPages;
}

function clampZoom(value) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
}

function updateZoomControls() {
  if (!pdfDoc) {
    zoomControls.hidden = true;
    return;
  }
  zoomControls.hidden = false;
  zoomValue.textContent = `${Math.round(zoomFactor * 100)}%`;
  zoomOutBtn.disabled = zoomFactor <= ZOOM_MIN + 0.001;
  zoomInBtn.disabled = zoomFactor >= ZOOM_MAX - 0.001;
  zoomFitBtn.disabled = Math.abs(zoomFactor - 1) < 0.001;
}

async function setZoom(nextZoomFactor) {
  if (!pdfDoc) {
    return;
  }
  const clamped = clampZoom(nextZoomFactor);
  if (Math.abs(clamped - zoomFactor) < 0.001) {
    return;
  }
  zoomFactor = clamped;
  await renderPage(currentPage);
}

prevPageBtn.addEventListener("click", async () => {
  if (currentPage > 1) {
    currentPage--;
    await renderPage(currentPage);
    updatePageNav();
  }
});

nextPageBtn.addEventListener("click", async () => {
  if (pdfDoc && currentPage < pdfDoc.numPages) {
    currentPage++;
    await renderPage(currentPage);
    updatePageNav();
  }
});

zoomOutBtn.addEventListener("click", () => {
  setZoom(zoomFactor - ZOOM_STEP).catch(console.error);
});

zoomInBtn.addEventListener("click", () => {
  setZoom(zoomFactor + ZOOM_STEP).catch(console.error);
});

zoomFitBtn.addEventListener("click", () => {
  setZoom(1).catch(console.error);
});

// ── Overlay Drawing ──
function redrawOverlay(inProgressRect = null) {
  const ctx = overlayCanvas.getContext("2d");
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  // Draw existing field rectangles for the current page
  fields.forEach((field, i) => {
    if (field.page !== currentPage || !currentPageData) return;
    const color = FIELD_COLORS[i % FIELD_COLORS.length];
    const resolvedRect = resolveFieldRect(field, currentPageData.pageWidth, currentPageData.pageHeight, {
      pageWidth: templatePageWidth,
      pageHeight: templatePageHeight,
    });
    if (!resolvedRect) return;
    const canvasRect = pdfRectToCanvasRect(resolvedRect, viewportScale, pageHeight);
    drawRect(ctx, canvasRect, color, field.label);
  });

  // Draw pending rect (awaiting a name) with dashed outline
  if (pendingRect && pendingRect.page === currentPage && currentPageData) {
    const resolved = resolveFieldRect(
      { rect: pendingRect.normalizedRect },
      currentPageData.pageWidth,
      currentPageData.pageHeight
    );
    if (resolved) {
      const cr = pdfRectToCanvasRect(resolved, viewportScale, pageHeight);
      ctx.strokeStyle = "#4263eb";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(cr.x, cr.y, cr.width, cr.height);
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(66, 99, 235, 0.12)";
      ctx.fillRect(cr.x, cr.y, cr.width, cr.height);
    }
  }

  // Draw in-progress rectangle
  if (inProgressRect) {
    ctx.strokeStyle = "#4263eb";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    ctx.strokeRect(
      inProgressRect.x,
      inProgressRect.y,
      inProgressRect.width,
      inProgressRect.height
    );
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(66, 99, 235, 0.1)";
    ctx.fillRect(
      inProgressRect.x,
      inProgressRect.y,
      inProgressRect.width,
      inProgressRect.height
    );
  }
}

function drawRect(ctx, rect, color, label) {
  // Fill
  ctx.fillStyle = color + "1a"; // ~10% opacity
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

  // Border
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);

  // Label
  if (label) {
    ctx.font = "bold 11px -apple-system, sans-serif";
    const metrics = ctx.measureText(label);
    const labelH = 16;
    const labelW = metrics.width + 8;
    const lx = rect.x;
    const ly = rect.y - labelH - 2;

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(lx, ly, labelW, labelH, 3);
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, lx + 4, ly + 12);
  }
}

// ── Mouse events for drawing rectangles ──
// Drawing is always allowed when a PDF is loaded (crosshair cursor).
// After drawing, user names the field inline.
overlayCanvas.addEventListener("mousedown", (e) => {
  if (!pdfDoc || pendingRect) return;

  isDrawing = true;
  const rect = overlayCanvas.getBoundingClientRect();
  drawStart = {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
  };
});

overlayCanvas.addEventListener("mousemove", (e) => {
  if (!isDrawing || !drawStart) return;
  const rect = overlayCanvas.getBoundingClientRect();
  const currentX = e.clientX - rect.left;
  const currentY = e.clientY - rect.top;

  const inProgress = {
    x: Math.min(drawStart.x, currentX),
    y: Math.min(drawStart.y, currentY),
    width: Math.abs(currentX - drawStart.x),
    height: Math.abs(currentY - drawStart.y),
  };

  redrawOverlay(inProgress);
});

overlayCanvas.addEventListener("mouseup", (e) => {
  if (!isDrawing || !drawStart) return;
  isDrawing = false;

  const rect = overlayCanvas.getBoundingClientRect();
  const endX = e.clientX - rect.left;
  const endY = e.clientY - rect.top;

  const canvasRect = {
    x: Math.min(drawStart.x, endX),
    y: Math.min(drawStart.y, endY),
    width: Math.abs(endX - drawStart.x),
    height: Math.abs(endY - drawStart.y),
  };

  drawStart = null;

  // Ignore tiny rects (accidental clicks)
  if (canvasRect.width < 5 || canvasRect.height < 5) {
    redrawOverlay();
    return;
  }

  // Convert to PDF coordinates
  const pdfRect = canvasRectToPdfRect(canvasRect, viewportScale, pageHeight);

  if (!currentPageData) {
    return;
  }

  // Extract sample text
  const sampleValue = extractTextFromRect(
    currentPageData.textItems,
    pdfRect,
    currentPageData.pageWidth,
    currentPageData.pageHeight
  );

  const normalizedRect = normalizeRect(
    pdfRect,
    currentPageData.pageWidth,
    currentPageData.pageHeight
  );

  // Redrawing an existing field — update it immediately
  if (drawingFieldId) {
    const existingField = fields.find((f) => f.id === drawingFieldId);
    if (existingField) {
      existingField.rect = normalizedRect;
      existingField.page = currentPage;
      existingField.sampleValue = sampleValue;
    }
    drawingFieldId = null;
    drawingHint.hidden = true;
    addFieldRow.hidden = false;
    renderFieldsList();
    redrawOverlay();
    updateSaveButton();
    return;
  }

  // Name-first flow: user already typed a name, now drew the rect
  if (nameFirstLabel) {
    fields.push({
      id: crypto.randomUUID(),
      label: nameFirstLabel,
      rect: normalizedRect,
      page: currentPage,
      sampleValue,
    });
    nameFirstLabel = null;
    drawingHint.hidden = true;
    addFieldRow.hidden = false;
    renderFieldsList();
    redrawOverlay();
    updateSaveButton();
    return;
  }

  // Draw-first flow: store rect and prompt for a name
  pendingRect = { normalizedRect, page: currentPage, sampleValue };
  addFieldRow.hidden = false;
  drawingHint.hidden = true;
  newFieldLabelInput.placeholder = "Name this field…";
  addFieldBtn.textContent = "Save Field";
  cancelPendingBtn.hidden = false;
  newFieldLabelInput.focus();
  redrawOverlay();
});

// ── Add / name field ──
let nameFirstLabel = null; // set when user names a field before drawing

addFieldBtn.addEventListener("click", () => {
  const label = newFieldLabelInput.value.trim();
  if (!label) {
    newFieldLabelInput.focus();
    return;
  }

  if (pendingRect) {
    // Draw-first flow: we have a rect, now we have a name
    fields.push({
      id: crypto.randomUUID(),
      label,
      rect: pendingRect.normalizedRect,
      page: pendingRect.page,
      sampleValue: pendingRect.sampleValue,
    });
    clearPendingRect();
    renderFieldsList();
    redrawOverlay();
    updateSaveButton();
  } else {
    // Name-first flow: enter drawing mode for this label
    nameFirstLabel = label;
    newFieldLabelInput.value = "";
    addFieldRow.hidden = true;
    drawingHint.hidden = false;
    drawingFieldName.textContent = label;
  }
});

newFieldLabelInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addFieldBtn.click();
  if (e.key === "Escape" && pendingRect) {
    clearPendingRect();
    redrawOverlay();
  }
});

async function beginRedrawField(fieldId) {
  const field = fields.find((f) => f.id === fieldId);
  if (!field || !pdfDoc) {
    return;
  }

  const targetPage = Math.min(Math.max(field.page || 1, 1), pdfDoc.numPages);
  if (targetPage !== currentPage) {
    currentPage = targetPage;
    await renderPage(currentPage);
    updatePageNav();
  }

  // Clear any pending state from a previous action
  nameFirstLabel = null;
  if (pendingRect) {
    clearPendingRect();
  }

  drawingFieldId = fieldId;
  addFieldRow.hidden = true;
  drawingHint.hidden = false;
  drawingFieldName.textContent = field.label;
  redrawOverlay();
}

cancelDrawingBtn.addEventListener("click", () => {
  drawingFieldId = null;
  nameFirstLabel = null;
  isDrawing = false;
  drawStart = null;
  clearPendingRect();
  addFieldRow.hidden = false;
  drawingHint.hidden = true;
  redrawOverlay();
});

cancelPendingBtn.addEventListener("click", () => {
  clearPendingRect();
  redrawOverlay();
});

// ── Fields List ──
function renderFieldsList() {
  fieldsList.innerHTML = "";

  fields.forEach((field, i) => {
    const color = FIELD_COLORS[i % FIELD_COLORS.length];
    const card = document.createElement("div");
    card.className = "field-card";
    card.style.setProperty("--field-color", color);
    const canRedraw = Boolean(pdfDoc);
    const redrawTitle = canRedraw ? "Redraw field" : "Upload a sample PDF to redraw";

    const r = field.rect;
    card.innerHTML = `
      <div class="field-header">
        <span class="field-label">${escapeHtml(field.label)}</span>
        <div class="field-card-actions">
          <button class="field-redraw" data-id="${field.id}" title="${redrawTitle}" ${canRedraw ? "" : "disabled"}>Redraw</button>
          <button class="field-delete" data-id="${field.id}" title="Delete field">&times;</button>
        </div>
      </div>
      <div class="field-value">
        ${field.sampleValue ? `&rarr; <span class="extracted">${escapeHtml(field.sampleValue)}</span>` : '<span style="color: var(--danger)">No text found in region</span>'}
      </div>
      <div class="field-coords">page ${field.page}, (${r.x.toFixed(3)}, ${r.y.toFixed(3)}, ${r.width.toFixed(3)}, ${r.height.toFixed(3)})</div>
    `;

    card.querySelector(".field-redraw").addEventListener("click", () => {
      beginRedrawField(field.id).catch(console.error);
    });

    card.querySelector(".field-delete").addEventListener("click", () => {
      fields = fields.filter((f) => f.id !== field.id);
      if (drawingFieldId === field.id) {
        drawingFieldId = null;
        addFieldRow.hidden = false;
        drawingHint.hidden = true;
      }
      renderFieldsList();
      redrawOverlay();
      updateSaveButton();
    });

    fieldsList.appendChild(card);
  });
}

// ── Save / Cancel ──
function updateSaveButton() {
  saveBtn.disabled =
    !templateNameInput.value.trim() || fields.length === 0;
}

templateNameInput.addEventListener("input", updateSaveButton);

saveBtn.addEventListener("click", async () => {
  const name = templateNameInput.value.trim();
  if (!name || fields.length === 0) return;

  let pageWidth = templatePageWidth;
  let pageHeightValue = templatePageHeight;
  if (pdfDoc) {
    const firstPage = await pdfDoc.getPage(1);
    const firstPageData = await getPageTextItems(firstPage);
    pageWidth = firstPageData.pageWidth;
    pageHeightValue = firstPageData.pageHeight;
  }

  const now = new Date().toISOString();

  const template = {
    ...(existingTemplate || {}),
    id: templateId || existingTemplate?.id || crypto.randomUUID(),
    name,
    created: templateCreatedAt || existingTemplate?.created || now,
    updated: now,
    pageWidth,
    pageHeight: pageHeightValue,
    fields: fields.map((f) => ({
      label: f.label,
      rect: f.rect,
      page: f.page,
    })),
  };

  await upsertTemplate(template);
  if (templateSamplePdf?.dataUrl) {
    await saveTemplateSamplePdf(template.id, templateSamplePdf);
  }
  chrome.runtime.sendMessage({ action: "close-template-builder" });
});

cancelBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "close-template-builder" });
});

// ── Setup screen ──
function initSetupScreen() {
  function updateContinueBtn() {
    setupContinueBtn.disabled = !setupNameInput.value.trim() || !setupPdfFile;
  }

  setupNameInput.addEventListener("input", updateContinueBtn);

  setupPdfFileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setupPdfFile = file;
    setupDropzoneText.textContent = file.name;
    setupDropzone.classList.add("has-file");
    updateContinueBtn();
  });

  setupDropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    setupDropzone.classList.add("dragover");
  });
  setupDropzone.addEventListener("dragleave", () => {
    setupDropzone.classList.remove("dragover");
  });
  setupDropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    setupDropzone.classList.remove("dragover");
    const file = Array.from(e.dataTransfer.files).find(
      (f) => f.type === "application/pdf"
    );
    if (!file) return;
    setupPdfFile = file;
    setupDropzoneText.textContent = file.name;
    setupDropzone.classList.add("has-file");
    updateContinueBtn();
  });

  setupContinueBtn.addEventListener("click", async () => {
    if (!setupNameInput.value.trim() || !setupPdfFile) return;

    // Apply name
    templateNameInput.value = setupNameInput.value.trim();

    // Hide overlay
    setupOverlay.hidden = true;

    await cacheSamplePdfFile(setupPdfFile);
    const arrayBuffer = await setupPdfFile.arrayBuffer();
    await loadPdfIntoBuilder(arrayBuffer, setupPdfFile.name);
    updateSaveButton();
  });

  setupNameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !setupContinueBtn.disabled) {
      setupContinueBtn.click();
    }
  });
}

// ── Helpers ──
async function reExtractSampleValues() {
  if (!pdfDoc) return;
  const pageCache = new Map();

  for (const field of fields) {
    if (field.page > pdfDoc.numPages) {
      field.sampleValue = "";
      continue;
    }

    let pageData = null;
    if (field.page === currentPage && currentPageData) {
      pageData = currentPageData;
    } else if (pageCache.has(field.page)) {
      pageData = pageCache.get(field.page);
    } else {
      const page = await pdfDoc.getPage(field.page);
      pageData = await getPageTextItems(page);
      pageCache.set(field.page, pageData);
    }

    const resolvedRect = resolveFieldRect(field, pageData.pageWidth, pageData.pageHeight, {
      pageWidth: templatePageWidth,
      pageHeight: templatePageHeight,
    });
    field.sampleValue = extractTextFromRect(
      pageData.textItems,
      resolvedRect,
      pageData.pageWidth,
      pageData.pageHeight
    );
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ── Start ──
init();

window.addEventListener("resize", () => {
  if (!pdfDoc) {
    return;
  }
  renderPage(currentPage).catch(console.error);
});
