import * as pdfjsLib from "../lib/pdf.mjs";
import { ensurePdfWorker } from "../lib/extractor.js";
import { GEMINI_API_KEY as DEFAULT_API_KEY, GEMINI_MODEL } from "./gemini-config.js";

ensurePdfWorker(pdfjsLib);

const PROMPT_STORAGE_KEY = "geminiPrompt";
const API_KEY_STORAGE_KEY = "geminiApiKey";
const BATCH_SIZE_STORAGE_KEY = "geminiBatchSize";
const INVOICE_META_KEY = "invoiceMeta";
const CONTEXT_MENU_FIELDS_KEY = "geminiContextMenuFields";
const DB_NAME = "invoiceClipperPdfs";
const DB_VERSION = 1;
const DB_STORE = "pdfs";
const DEFAULT_PARALLEL_BATCH_SIZE = 5;
const MIN_PARALLEL_BATCH_SIZE = 1;
const MAX_PARALLEL_BATCH_SIZE = 50;
const MAX_RETRIES = 3;
const DEFAULT_RETRY_WAIT_MS = 60000;

let geminiApiKey = "";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE)) {
        req.result.createObjectStore(DB_STORE, { keyPath: "idx" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function savePdfsToDb(files) {
  const records = await Promise.all(
    files.map(async (file, i) => ({
      idx: i,
      filename: file.name,
      filePath: getUploadedFilePath(file),
      data: await file.arrayBuffer(),
    }))
  );
  const db = await openDb();
  const tx = db.transaction(DB_STORE, "readwrite");
  const store = tx.objectStore(DB_STORE);
  store.clear();
  records.forEach((r) => store.put(r));
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function loadPdfsFromDb() {
  const db = await openDb();
  const tx = db.transaction(DB_STORE, "readonly");
  const req = tx.objectStore(DB_STORE).getAll();
  const records = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return records.map((r) => ({
    file: new File([r.data], r.filename, { type: "application/pdf" }),
    filename: r.filename,
    filePath: r.filePath,
  }));
}

function saveInvoiceMeta() {
  const meta = {
    lastExtractionPrompt,
    currentIndex,
    invoices: invoices.map((inv) => ({
      filename: inv.filename,
      filePath: inv.filePath,
      fields: inv.fields,
      rawResponse: inv.rawResponse,
      completed: inv.completed,
      error: inv.error || "",
    })),
  };
  chrome.storage.local.set({ [INVOICE_META_KEY]: meta }).catch(console.error);
}

function normalizeBatchSize(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_PARALLEL_BATCH_SIZE;
  }
  return Math.min(MAX_PARALLEL_BATCH_SIZE, Math.max(MIN_PARALLEL_BATCH_SIZE, parsed));
}

let invoices = []; // { file, filename, filePath, fields, rawResponse, completed, error, pdfDoc, pdfDocError, pdfDocPromise }
let currentIndex = 0;
let promptSaveTimer = null;
let currentRenderTask = null;
let uploadedFiles = [];
let lastExtractionPrompt = "";
let isProcessing = false;
let parallelBatchSize = DEFAULT_PARALLEL_BATCH_SIZE;

const templateLikeColors = [
  "#4263eb", "#e03131", "#2b8a3e", "#e8590c",
  "#9c36b5", "#0c8599", "#e67700", "#d6336c",
];

const promptInput = document.getElementById("promptInput");
const rerunExtractionBtn = document.getElementById("rerunExtractionBtn");
const uploadArea = document.getElementById("uploadArea");
const pdfFilesInput = document.getElementById("pdfFiles");
const status = document.getElementById("status");
const invoiceView = document.getElementById("invoiceView");
const invoiceCounter = document.getElementById("invoiceCounter");
const invoiceFilename = document.getElementById("invoiceFilename");
const copyFilenameBtn = document.getElementById("copyFilenameBtn");
const markComplete = document.getElementById("markComplete");
const fieldsContainer = document.getElementById("fieldsContainer");
const prevInvoiceBtn = document.getElementById("prevInvoice");
const nextInvoiceBtn = document.getElementById("nextInvoice");
const progressDots = document.getElementById("progressDots");
const progressMeta = document.getElementById("progressMeta");
const previewContainer = document.getElementById("previewContainer");
const previewCanvas = document.getElementById("previewCanvas");
const exportCsvBtn = document.getElementById("exportCsvBtn");
const settingsBtn = document.getElementById("settingsBtn");
const settingsOverlay = document.getElementById("settingsOverlay");
const settingsCloseBtn = document.getElementById("settingsCloseBtn");
const settingsSaveBtn = document.getElementById("settingsSaveBtn");
const apiKeyInput = document.getElementById("apiKeyInput");
const apiKeyToggleBtn = document.getElementById("apiKeyToggleBtn");
const batchSizeInput = document.getElementById("batchSizeInput");

async function init() {
  const saved = await chrome.storage.local.get([
    PROMPT_STORAGE_KEY,
    API_KEY_STORAGE_KEY,
    BATCH_SIZE_STORAGE_KEY,
    INVOICE_META_KEY,
  ]);
  promptInput.value = saved[PROMPT_STORAGE_KEY] || "";
  geminiApiKey = saved[API_KEY_STORAGE_KEY] || DEFAULT_API_KEY || "";
  parallelBatchSize = normalizeBatchSize(saved[BATCH_SIZE_STORAGE_KEY]);

  if (!geminiApiKey) {
    showStatus("No API key set. Click the gear icon to add your Gemini API key.");
  }

  const meta = saved[INVOICE_META_KEY];
  if (meta?.invoices?.length) {
    try {
      const pdfRecords = await loadPdfsFromDb();
      if (pdfRecords.length === meta.invoices.length) {
        invoices = meta.invoices.map((inv, i) => ({
          file: pdfRecords[i].file,
          filename: inv.filename,
          filePath: inv.filePath,
          fields: normalizeFieldMap(inv.fields || {}),
          rawResponse: inv.rawResponse || "",
          completed: Boolean(inv.completed),
          error: inv.error || undefined,
          pdfDoc: null,
          pdfDocError: null,
          pdfDocPromise: null,
        }));
        uploadedFiles = pdfRecords.map((r) => r.file);
        lastExtractionPrompt = meta.lastExtractionPrompt || "";
        currentIndex = Math.min(meta.currentIndex || 0, invoices.length - 1);
      }
    } catch (err) {
      console.error("Failed to restore session", err);
    }
  }

  renderInvoice();
  refreshRerunButton();
}

function queuePromptSave() {
  if (promptSaveTimer) {
    clearTimeout(promptSaveTimer);
  }
  promptSaveTimer = setTimeout(() => {
    chrome.storage.local
      .set({ [PROMPT_STORAGE_KEY]: promptInput.value.trim() })
      .catch(console.error);
  }, 250);
}

function showStatus(message) {
  status.textContent = message;
  status.hidden = false;
}

function hideStatus() {
  status.hidden = true;
}

function refreshRerunButton() {
  const prompt = promptInput.value.trim();
  const hasFiles = uploadedFiles.length > 0;
  const shouldShow = hasFiles && prompt.length > 0 && prompt !== lastExtractionPrompt;
  rerunExtractionBtn.hidden = !shouldShow;
  rerunExtractionBtn.disabled = isProcessing;
}

function buildContextMenuFields(invoice) {
  if (!invoice?.fields) {
    return [];
  }

  return Object.entries(normalizeFieldMap(invoice.fields))
    .map(([key, value]) => ({
      key,
      label: String(key).replace(/_/g, " "),
      value: value == null ? "" : String(value).trim(),
    }))
    .filter((field) => field.value.length > 0);
}

function syncContextMenuFields(invoice) {
  if (!invoice) {
    chrome.storage.local.remove(CONTEXT_MENU_FIELDS_KEY).catch(console.error);
    return;
  }
  const fields = buildContextMenuFields(invoice);
  chrome.storage.local.set({ [CONTEXT_MENU_FIELDS_KEY]: fields }).catch(console.error);
}

function getUploadedFilePath(file) {
  if (!file) {
    return "";
  }

  if (typeof file.path === "string" && file.path.trim()) {
    return file.path.trim();
  }

  if (typeof file.webkitRelativePath === "string" && file.webkitRelativePath.trim()) {
    return file.webkitRelativePath.trim();
  }

  return file.name || "";
}

function toCsvCell(value) {
  const text = value == null ? "" : String(value);
  const escaped = text.replace(/"/g, '""');
  if (/[",\n\r]/.test(escaped)) {
    return `"${escaped}"`;
  }
  return escaped;
}

function createCsvFilename() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `gemini-invoice-export-${timestamp}.csv`;
}

function downloadTextFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function buildInvoicesCsv() {
  const normalizedFieldMaps = invoices.map((invoice) => normalizeFieldMap(invoice.fields));
  const fieldKeySet = new Set();
  normalizedFieldMaps.forEach((fieldMap) => {
    Object.keys(fieldMap).forEach((key) => fieldKeySet.add(key));
  });

  const fieldHeaders = Array.from(fieldKeySet);
  const headers = ["Filename", "Done", "Error", ...fieldHeaders];
  const lines = [headers.map(toCsvCell).join(",")];

  invoices.forEach((invoice, index) => {
    const normalizedFields = normalizedFieldMaps[index];
    const row = [
      invoice.filename,
      invoice.completed ? "Yes" : "No",
      invoice.error || "",
    ];

    fieldHeaders.forEach((key) => {
      row.push(normalizedFields?.[key] ?? "");
    });

    lines.push(row.map(toCsvCell).join(","));
  });

  return lines.join("\r\n");
}

function normalizeModelValue(value) {
  if (value == null) {
    return "";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function canonicalizeFieldKey(rawKey) {
  const normalized = String(rawKey || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  return normalized || "field";
}

function normalizeFieldMap(fields) {
  if (!fields || typeof fields !== "object") {
    return {};
  }

  const normalized = {};

  Object.entries(fields).forEach(([rawKey, rawValue]) => {
    const key = canonicalizeFieldKey(rawKey);
    const value = normalizeModelValue(rawValue).trim();
    const hasKey = Object.prototype.hasOwnProperty.call(normalized, key);

    if (!hasKey || (!normalized[key] && value)) {
      normalized[key] = value;
      return;
    }

    if (value && normalized[key] && normalized[key] !== value && value.length > normalized[key].length) {
      normalized[key] = value;
    }
  });

  return normalized;
}

function extractJsonPayload(text) {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return JSON.parse(withoutFence);
  } catch {
    const start = withoutFence.indexOf("{");
    const end = withoutFence.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(withoutFence.slice(start, end + 1));
    }
    return null;
  }
}

function extractTextFromGeminiResponse(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  return parts
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryDelayMs(response, parsedError) {
  const headerValue = response.headers.get("retry-after");
  if (headerValue) {
    const asNumber = Number(headerValue);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      return Math.round(asNumber * 1000);
    }
  }

  const retryInfo = parsedError?.error?.details?.find(
    (detail) => detail?.["@type"] === "type.googleapis.com/google.rpc.RetryInfo"
  );
  const retryDelay = retryInfo?.retryDelay;
  if (typeof retryDelay === "string") {
    const seconds = Number.parseFloat(retryDelay.replace("s", ""));
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.round(seconds * 1000);
    }
  }

  const message = parsedError?.error?.message;
  if (typeof message === "string") {
    const match = message.match(/retry in\\s+([0-9]+(?:\\.[0-9]+)?)s/i);
    if (match) {
      const seconds = Number.parseFloat(match[1]);
      if (Number.isFinite(seconds) && seconds > 0) {
        return Math.round(seconds * 1000);
      }
    }
  }

  return null;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function ensureInvoicePdfDoc(invoice) {
  if (!invoice?.file) {
    return null;
  }
  if (invoice.pdfDoc) {
    return invoice.pdfDoc;
  }
  if (invoice.pdfDocError) {
    return null;
  }
  if (!invoice.pdfDocPromise) {
    invoice.pdfDocPromise = invoice.file
      .arrayBuffer()
      .then((buffer) => pdfjsLib.getDocument({ data: buffer }).promise)
      .then((doc) => {
        invoice.pdfDoc = doc;
        return doc;
      })
      .catch((error) => {
        invoice.pdfDocError = error;
        console.error("Failed to load PDF for preview", error);
        return null;
      });
  }
  return invoice.pdfDocPromise;
}

async function runGeminiExtraction(file, prompt) {
  const bytes = await file.arrayBuffer();
  const base64Pdf = arrayBufferToBase64(bytes);

  const instruction = [
    "You are an invoice extraction engine.",
    "Use the user's prompt to decide what values to extract.",
    "Return only a valid JSON object.",
    "If a value is not found, use an empty string.",
    "Do not wrap output in markdown fences.",
    "USER PROMPT:",
    prompt,
  ].join("\n");

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    GEMINI_MODEL
  )}:generateContent?key=${encodeURIComponent(geminiApiKey)}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { text: instruction },
            {
              inlineData: {
                mimeType: "application/pdf",
                data: base64Pdf,
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
      },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    let parsedError = null;
    try {
      parsedError = JSON.parse(errorBody);
    } catch {
      parsedError = null;
    }

    const retryAfterMs = parseRetryDelayMs(response, parsedError);
    const detailMessage = parsedError?.error?.message || errorBody;
    const error = new Error(`Gemini request failed (${response.status}): ${detailMessage}`);
    error.status = response.status;
    error.retryAfterMs = retryAfterMs;
    error.rawBody = errorBody;
    throw error;
  }

  const payload = await response.json();
  const modelText = extractTextFromGeminiResponse(payload);
  const parsed = modelText ? extractJsonPayload(modelText) : null;

  let fields = {};
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    fields = normalizeFieldMap(parsed);
  } else if (modelText) {
    fields = { model_output: modelText };
  }

  return {
    fields,
    rawResponse: modelText,
  };
}

async function runGeminiExtractionWithRetry(file, prompt, total, index, onRetryWait) {
  let attempt = 0;
  while (attempt <= MAX_RETRIES) {
    try {
      return await runGeminiExtraction(file, prompt);
    } catch (error) {
      const statusCode = Number(error?.status) || 0;
      const retryable = statusCode === 429 || statusCode >= 500;
      if (!retryable || attempt >= MAX_RETRIES) {
        throw error;
      }

      const waitMs = Math.max(
        1000,
        Number(error?.retryAfterMs) || DEFAULT_RETRY_WAIT_MS
      );
      const nextAttempt = attempt + 2;
      onRetryWait?.(waitMs, nextAttempt, MAX_RETRIES + 1, total, index, file.name);
      await sleep(waitMs);
    }
    attempt += 1;
  }

  throw new Error("Retry loop ended unexpectedly.");
}

async function processFiles(files) {
  if (isProcessing) {
    return;
  }

  const prompt = promptInput.value.trim();
  if (!prompt) {
    showStatus("Enter an extraction prompt first.");
    refreshRerunButton();
    return;
  }

  if (!geminiApiKey) {
    showStatus("No API key set. Click the gear icon to add your Gemini API key.");
    refreshRerunButton();
    return;
  }

  if (!files.length) {
    showStatus("Upload at least one PDF.");
    refreshRerunButton();
    return;
  }

  uploadedFiles = files.slice();
  isProcessing = true;
  refreshRerunButton();

  // Read file data now while handles are fresh, save to IndexedDB
  savePdfsToDb(files).catch((err) => console.error("Failed to save PDFs", err));

  invoices = [];
  currentIndex = 0;
  renderInvoice();

  let completedCount = 0;
  const totalFiles = files.length;
  const results = [];

  try {
    for (let batchStart = 0; batchStart < totalFiles; batchStart += parallelBatchSize) {
      const batch = files.slice(batchStart, batchStart + parallelBatchSize);
      const batchLabel = `${Math.floor(batchStart / parallelBatchSize) + 1}/${Math.ceil(
        totalFiles / parallelBatchSize
      )}`;
      showStatus(
        `Running batch ${batchLabel} (${batch.length} PDF${batch.length > 1 ? "s" : ""}, size ${parallelBatchSize})...`
      );

      const batchResults = await Promise.all(
        batch.map(async (file, batchOffset) => {
          const index = batchStart + batchOffset;
          try {
            const extraction = await runGeminiExtractionWithRetry(
              file,
              prompt,
              totalFiles,
              index,
              (waitMs, attemptNumber, maxAttempts, total, current) => {
                const seconds = (waitMs / 1000).toFixed(1);
                showStatus(
                  `Rate limited on ${current + 1}/${total}. Retrying in ${seconds}s (attempt ${attemptNumber}/${maxAttempts}).`
                );
              }
            );
            return {
              file,
              filename: file.name,
              filePath: getUploadedFilePath(file),
              fields: extraction.fields,
              rawResponse: extraction.rawResponse,
              completed: false,
              pdfDoc: null,
              pdfDocError: null,
              pdfDocPromise: null,
            };
          } catch (error) {
            console.error("Extraction failed", error);
            return {
              file,
              filename: file.name,
              filePath: getUploadedFilePath(file),
              fields: {},
              rawResponse: "",
              completed: false,
              error: error?.message || String(error),
              pdfDoc: null,
              pdfDocError: null,
              pdfDocPromise: null,
            };
          } finally {
            completedCount += 1;
            showStatus(`Processed ${completedCount}/${totalFiles} PDF(s)...`);
          }
        })
      );

      results.push(...batchResults);
    }
  } finally {
    isProcessing = false;
  }

  invoices = results;
  lastExtractionPrompt = prompt;
  refreshRerunButton();

  if (invoices.length) {
    showStatus(`Finished extracting ${invoices.length} PDF(s).`);
  }

  renderInvoice();
  saveInvoiceMeta();
}

function renderInvoice() {
  if (!invoices.length) {
    invoiceView.hidden = true;
    exportCsvBtn.disabled = true;
    previewContainer.hidden = true;
    syncContextMenuFields(null);
    return;
  }

  invoiceView.hidden = false;
  exportCsvBtn.disabled = false;

  const invoice = invoices[currentIndex];
  invoiceCounter.textContent = `Invoice ${currentIndex + 1} of ${invoices.length}`;
  invoiceFilename.textContent = invoice.filename;
  copyFilenameBtn.textContent = "Copy Name";
  copyFilenameBtn.classList.remove("copied");
  markComplete.checked = Boolean(invoice.completed);
  syncContextMenuFields(invoice);

  renderPreview(invoice).catch((error) => {
    console.error("Preview render failed", error);
    previewContainer.hidden = true;
  });

  fieldsContainer.innerHTML = "";
  const entries = Object.entries(normalizeFieldMap(invoice.fields));

  if (invoice.error) {
    entries.unshift(["error", invoice.error]);
  }

  if (!entries.length) {
    entries.push(["result", "No structured fields returned."]);
  }

  entries.forEach(([key, value], i) => {
    const row = document.createElement("div");
    row.className = "field-row";
    row.style.borderLeft = `3px solid ${templateLikeColors[i % templateLikeColors.length]}`;

    const label = document.createElement("span");
    label.className = "field-label";
    label.textContent = key;
    row.appendChild(label);

    const valueEl = document.createElement("span");
    valueEl.className = "field-value";
    const normalizedValue = value == null ? "" : String(value);
    if (normalizedValue) {
      valueEl.textContent = normalizedValue;
    } else {
      valueEl.textContent = "Empty";
      valueEl.classList.add("empty");
    }
    row.appendChild(valueEl);

    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-btn";
    copyBtn.textContent = "Copy";
    copyBtn.disabled = !normalizedValue;
    if (!copyBtn.disabled) {
      copyBtn.addEventListener("click", () => {
        copyToClipboard(copyBtn, normalizedValue);
      });
    }
    row.appendChild(copyBtn);

    fieldsContainer.appendChild(row);
  });

  prevInvoiceBtn.disabled = currentIndex <= 0;
  nextInvoiceBtn.disabled = currentIndex >= invoices.length - 1;
  renderProgress();
}

function renderProgress() {
  progressDots.innerHTML = "";
  invoices.forEach((invoice, i) => {
    const dot = document.createElement("div");
    dot.className = "progress-dot";
    if (i === currentIndex) dot.classList.add("current");
    if (invoice.completed) dot.classList.add("completed");
    dot.addEventListener("click", () => {
      currentIndex = i;
      renderInvoice();
      saveInvoiceMeta();
    });
    progressDots.appendChild(dot);
  });

  const completedCount = invoices.filter((invoice) => invoice.completed).length;
  progressMeta.textContent = `${completedCount}/${invoices.length}`;
}

async function renderPreview(invoice) {
  const pdfDoc = await ensureInvoicePdfDoc(invoice);
  if (!pdfDoc) {
    previewContainer.hidden = true;
    return;
  }

  if (currentRenderTask) {
    currentRenderTask.cancel();
    currentRenderTask = null;
  }

  previewContainer.hidden = false;

  const page = await pdfDoc.getPage(1);
  const baseViewport = page.getViewport({ scale: 1 });
  const containerWidth = previewContainer.clientWidth || 300;
  const scale = containerWidth / baseViewport.width;
  const viewport = page.getViewport({ scale });

  previewCanvas.width = viewport.width;
  previewCanvas.height = viewport.height;

  const ctx = previewCanvas.getContext("2d");
  const renderTask = page.render({ canvasContext: ctx, viewport });
  currentRenderTask = renderTask;

  try {
    await renderTask.promise;
  } catch (error) {
    if (error?.name === "RenderingCancelledException") {
      return;
    }
    throw error;
  } finally {
    if (currentRenderTask === renderTask) {
      currentRenderTask = null;
    }
  }
}

async function copyToClipboard(btn, text, defaultLabel = "Copy", copiedLabel = "Copied!") {
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = copiedLabel;
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = defaultLabel;
      btn.classList.remove("copied");
    }, 1200);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    btn.textContent = copiedLabel;
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = defaultLabel;
      btn.classList.remove("copied");
    }, 1200);
  }
}

promptInput.addEventListener("input", () => {
  queuePromptSave();
  refreshRerunButton();
});

pdfFilesInput.addEventListener("change", (event) => {
  const files = Array.from(event.target.files || []);
  if (files.length > 0) {
    uploadedFiles = files.slice();
    refreshRerunButton();
    processFiles(files).catch(console.error);
  }
});

uploadArea.addEventListener("dragover", (event) => {
  event.preventDefault();
  uploadArea.classList.add("dragover");
});

uploadArea.addEventListener("dragleave", () => {
  uploadArea.classList.remove("dragover");
});

uploadArea.addEventListener("drop", (event) => {
  event.preventDefault();
  uploadArea.classList.remove("dragover");
  const files = Array.from(event.dataTransfer.files || []).filter(
    (file) => file.type === "application/pdf"
  );
  if (files.length > 0) {
    uploadedFiles = files.slice();
    refreshRerunButton();
    processFiles(files).catch(console.error);
  }
});

rerunExtractionBtn.addEventListener("click", () => {
  if (!uploadedFiles.length) {
    showStatus("Upload PDFs first.");
    return;
  }
  processFiles(uploadedFiles).catch(console.error);
});

previewContainer.addEventListener("click", async () => {
  const invoice = invoices[currentIndex];
  if (!invoice?.file) {
    return;
  }

  const arrayBuffer = await invoice.file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  await chrome.storage.local.set({ viewerPdfBase64: btoa(binary) });

  chrome.runtime.sendMessage({
    action: "open-pdf-viewer",
    filename: invoice.filename,
  });
});

copyFilenameBtn.addEventListener("click", () => {
  const invoice = invoices[currentIndex];
  if (!invoice) {
    return;
  }
  copyToClipboard(copyFilenameBtn, invoice.filename, "Copy Name", "Copied!").catch(console.error);
});

markComplete.addEventListener("change", () => {
  const invoice = invoices[currentIndex];
  if (!invoice) {
    return;
  }
  invoice.completed = markComplete.checked;
  renderProgress();
  saveInvoiceMeta();
});

prevInvoiceBtn.addEventListener("click", () => {
  if (currentIndex > 0) {
    currentIndex -= 1;
    renderInvoice();
    saveInvoiceMeta();
  }
});

nextInvoiceBtn.addEventListener("click", () => {
  if (currentIndex < invoices.length - 1) {
    currentIndex += 1;
    renderInvoice();
    saveInvoiceMeta();
  }
});

exportCsvBtn.addEventListener("click", () => {
  if (!invoices.length) {
    showStatus("Load at least one invoice to export CSV.");
    return;
  }

  const csv = buildInvoicesCsv();
  downloadTextFile(csv, createCsvFilename(), "text/csv;charset=utf-8");
  showStatus(`Exported ${invoices.length} invoice(s) to CSV.`);
});

settingsBtn.addEventListener("click", () => {
  apiKeyInput.value = geminiApiKey;
  batchSizeInput.value = String(parallelBatchSize);
  apiKeyInput.type = "password";
  apiKeyToggleBtn.textContent = "Show";
  settingsOverlay.hidden = false;
});

function closeSettings() {
  settingsOverlay.hidden = true;
}

settingsCloseBtn.addEventListener("click", closeSettings);

settingsOverlay.addEventListener("click", (event) => {
  if (event.target === settingsOverlay) {
    closeSettings();
  }
});

apiKeyToggleBtn.addEventListener("click", () => {
  const isHidden = apiKeyInput.type === "password";
  apiKeyInput.type = isHidden ? "text" : "password";
  apiKeyToggleBtn.textContent = isHidden ? "Hide" : "Show";
});

settingsSaveBtn.addEventListener("click", async () => {
  const newKey = apiKeyInput.value.trim();
  const newBatchSize = normalizeBatchSize(batchSizeInput.value);
  geminiApiKey = newKey;
  parallelBatchSize = newBatchSize;
  batchSizeInput.value = String(parallelBatchSize);
  await chrome.storage.local.set({
    [API_KEY_STORAGE_KEY]: newKey,
    [BATCH_SIZE_STORAGE_KEY]: parallelBatchSize,
  });
  closeSettings();
  if (newKey) {
    hideStatus();
  } else {
    showStatus("No API key set. Click the gear icon to add your Gemini API key.");
  }
});

window.addEventListener("resize", () => {
  if (!invoices.length) {
    return;
  }
  renderPreview(invoices[currentIndex]).catch(console.error);
});

init().catch((error) => {
  console.error(error);
  showStatus(`Initialization failed: ${error?.message || String(error)}`);
});
