import * as pdfjsLib from "../lib/pdf.mjs";
import {
  ensurePdfWorker,
  resolveFieldRect,
  pdfRectToCanvasRect,
  getPageTextItems,
} from "../lib/extractor.js";
import { loadTemplates } from "../lib/storage.js";

ensurePdfWorker(pdfjsLib);

const FIELD_COLORS = [
  "#4263eb", "#e03131", "#2b8a3e", "#e8590c",
  "#9c36b5", "#0c8599", "#e67700", "#d6336c",
];

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.1;

// ── State ──
let pdfDoc = null;
let template = null;
let currentPage = 1;
let currentPageData = null;
let fitScale = 1;
let zoomFactor = 1;
let viewportScale = 1;

// ── DOM refs ──
const filenameEl = document.getElementById("filename");
const pageNav = document.getElementById("pageNav");
const prevPageBtn = document.getElementById("prevPage");
const nextPageBtn = document.getElementById("nextPage");
const pageInfo = document.getElementById("pageInfo");
const zoomOutBtn = document.getElementById("zoomOut");
const zoomInBtn = document.getElementById("zoomIn");
const zoomFitBtn = document.getElementById("zoomFit");
const zoomValue = document.getElementById("zoomValue");
const pdfPageEl = document.getElementById("pdfPage");
const pdfCanvas = document.getElementById("pdfCanvas");
const overlayCanvas = document.getElementById("overlayCanvas");
const legend = document.getElementById("legend");

// ── Init ──
async function init() {
  const params = new URLSearchParams(window.location.search);
  const templateId = params.get("templateId");
  const filename = params.get("filename");

  if (filename) {
    filenameEl.textContent = filename;
    document.title = `Invoice Clipper — ${filename}`;
  }

  // Load template
  if (templateId) {
    const templates = await loadTemplates();
    template = templates.find((t) => t.id === templateId) || null;
  }

  // Load PDF from storage
  const data = await chrome.storage.local.get("viewerPdfBase64");
  if (!data.viewerPdfBase64) return;

  const binary = atob(data.viewerPdfBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  // Clean up temp storage
  chrome.storage.local.remove("viewerPdfBase64");

  pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
  currentPage = 1;

  await renderPage(currentPage);
  updatePageNav();
  renderLegend();
}

// ── Render ──
async function renderPage(pageNum) {
  const page = await pdfDoc.getPage(pageNum);
  const scrollEl = document.getElementById("viewerScroll");
  const viewerWidth = scrollEl.clientWidth - 32;
  const unscaledViewport = page.getViewport({ scale: 1 });

  fitScale = viewerWidth / unscaledViewport.width;
  viewportScale = fitScale * zoomFactor;

  const viewport = page.getViewport({ scale: viewportScale });

  pdfCanvas.width = viewport.width;
  pdfCanvas.height = viewport.height;
  pdfCanvas.style.width = viewport.width + "px";
  pdfCanvas.style.height = viewport.height + "px";

  overlayCanvas.width = viewport.width;
  overlayCanvas.height = viewport.height;
  overlayCanvas.style.width = viewport.width + "px";
  overlayCanvas.style.height = viewport.height + "px";

  const ctx = pdfCanvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;

  currentPageData = await getPageTextItems(page);
  redrawOverlay();
  updateZoomControls();
}

function redrawOverlay() {
  const ctx = overlayCanvas.getContext("2d");
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  if (!template || !currentPageData) return;

  const fields = template.fields || [];
  fields.forEach((field, i) => {
    if ((field.page || 1) !== currentPage) return;

    const color = FIELD_COLORS[i % FIELD_COLORS.length];
    const resolvedRect = resolveFieldRect(
      field,
      currentPageData.pageWidth,
      currentPageData.pageHeight,
      { pageWidth: template.pageWidth, pageHeight: template.pageHeight }
    );
    if (!resolvedRect) return;

    const canvasRect = pdfRectToCanvasRect(resolvedRect, viewportScale);
    drawRect(ctx, canvasRect, color, field.label);
  });
}

function drawRect(ctx, rect, color, label) {
  // Fill
  ctx.fillStyle = color + "1a";
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

  // Border
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);

  // Label tag
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

// ── Legend ──
function renderLegend() {
  legend.innerHTML = "";
  if (!template) return;

  (template.fields || []).forEach((field, i) => {
    const color = FIELD_COLORS[i % FIELD_COLORS.length];
    const item = document.createElement("div");
    item.className = "legend-item";

    const dot = document.createElement("span");
    dot.className = "legend-dot";
    dot.style.background = color;
    item.appendChild(dot);

    const name = document.createElement("span");
    name.textContent = field.label;
    item.appendChild(name);

    legend.appendChild(item);
  });
}

// ── Page nav ──
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

// ── Zoom ──
function updateZoomControls() {
  zoomValue.textContent = `${Math.round(zoomFactor * 100)}%`;
  zoomOutBtn.disabled = zoomFactor <= ZOOM_MIN + 0.001;
  zoomInBtn.disabled = zoomFactor >= ZOOM_MAX - 0.001;
  zoomFitBtn.disabled = Math.abs(zoomFactor - 1) < 0.001;
}

async function setZoom(next) {
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
  if (Math.abs(clamped - zoomFactor) < 0.001) return;
  zoomFactor = clamped;
  await renderPage(currentPage);
}

zoomOutBtn.addEventListener("click", () => setZoom(zoomFactor - ZOOM_STEP));
zoomInBtn.addEventListener("click", () => setZoom(zoomFactor + ZOOM_STEP));
zoomFitBtn.addEventListener("click", () => setZoom(1));

window.addEventListener("resize", () => {
  if (pdfDoc) renderPage(currentPage).catch(console.error);
});

// ── Start ──
init();
