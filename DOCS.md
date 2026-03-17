# Invoice Clipper (Gemini) - Technical Architecture

This document explains how the extension is structured and how data moves through it, so a teammate can safely modify or extend it.

## 1) Product Scope

The Gemini version of Invoice Clipper extracts invoice values from PDFs using a single user prompt and Gemini (`gemini-2.5-flash` by default), then supports:

- per-field copy
- filename copy
- context-menu paste into external web forms
- mini PDF preview + full PDF viewer
- CSV export of extracted results
- extraction rerun when prompt changes

## 2) Runtime Components

### Side Panel UI (primary app)

- Path: `sidepanel/index.html`, `sidepanel/app.js`, `sidepanel/styles.css`
- Responsibilities:
  - user input (prompt + uploaded PDFs)
  - settings (API key, PDFs-per-batch)
  - orchestration of extraction pipeline
  - invoice state rendering and navigation
  - mini PDF preview render
  - CSV export
  - syncing current invoice fields for context menu

### Background Service Worker

- Path: `background.js`
- Responsibilities:
  - configure side panel behavior (`openPanelOnActionClick`)
  - build and rebuild dynamic context menu entries from storage
  - route context menu click -> content script paste action
  - open full PDF viewer tab

### Content Script

- Path: `content.js`
- Responsibilities (used in Gemini flow):
  - track last right-clicked element
  - receive `paste-field-value` messages
  - insert value into editable target with input/change events

Note: `content.js` still contains macro helpers from the hybrid branch. Gemini flow currently only depends on paste behavior.

### Full PDF Viewer

- Path: `pdf-viewer/index.html`, `pdf-viewer/viewer.js`, `pdf-viewer/styles.css`
- Responsibilities:
  - load temporary PDF bytes from storage (`viewerPdfBase64`)
  - render full document with page nav and zoom controls
  - optionally draw template overlays when `templateId` is present in URL

### Shared PDF/Storage Utilities

- `lib/extractor.js`
  - PDF.js worker setup
  - text extraction primitives (rect overlap, line joining, coordinate conversions)
- `lib/storage.js`
  - template storage helpers (legacy/compat; mostly used by template-builder/viewer)

### Legacy Template Builder (kept in repo)

- Path: `template-builder/*`
- This is the visual rectangle template system from the hybrid extension.
- Not used by the Gemini side panel extraction flow, but still present and functional if opened.

## 3) Manifest and Permissions

- Path: `manifest.json`
- MV3 extension with:
  - `side_panel.default_path = sidepanel/index.html`
  - `background.service_worker = background.js`
  - content script on `<all_urls>`
- Permissions:
  - `storage`, `unlimitedStorage`, `sidePanel`, `tabs`, `contextMenus`
- Host permissions:
  - `https://generativelanguage.googleapis.com/*`

## 4) Data Model

## 4.1 In-Memory Invoice Object (`sidepanel/app.js`)

Each invoice row in memory is shaped like:

```js
{
  file,             // File object
  filename,         // string
  filePath,         // best-available path hint (name/relative/path when browser exposes)
  fields,           // normalized key->value object
  rawResponse,      // raw model text response
  completed,        // boolean (user toggled)
  error,            // optional error string
  pdfDoc,           // cached PDF.js document
  pdfDocError,      // optional load error
  pdfDocPromise     // in-flight PDF load promise
}
```

## 4.2 Field Normalization

`normalizeFieldMap()` canonicalizes keys to prevent duplicate columns and menu entries:

- lowercases
- replaces non-alphanumeric with `_`
- collapses duplicate underscores
- trims leading/trailing underscores

Example:

- `"Account Number"` -> `account_number`
- `"account number"` -> `account_number`

If multiple raw keys collapse to same canonical key, non-empty/longer values win.

## 5) Persistence Model

## 5.1 `chrome.storage.local` Keys

- `geminiPrompt`: current prompt textarea value
- `geminiApiKey`: API key set in settings modal
- `geminiBatchSize`: configured PDFs per batch (default 5)
- `invoiceMeta`: lightweight session metadata
  - `lastExtractionPrompt`
  - `currentIndex`
  - `invoices[]` without raw File bytes
- `geminiContextMenuFields`: array used by background to build context menu
- `viewerPdfBase64`: transient payload to hand a PDF to full viewer tab

## 5.2 IndexedDB (`invoiceClipperPdfs`)

- DB name: `invoiceClipperPdfs`
- Version: `1`
- Store: `pdfs` (keyPath: `idx`)
- Record shape:

```js
{ idx, filename, filePath, data /* ArrayBuffer */ }
```

Purpose: retain actual PDF bytes across side panel reloads while `invoiceMeta` restores extracted metadata.

## 6) Extraction Lifecycle

## 6.1 Trigger

Extraction starts when:

- user uploads/drops PDFs, or
- user clicks `Extract Info` rerun button after prompt change

Guards before run:

- prompt must be non-empty
- API key must exist
- at least one PDF must be provided
- no parallel run already in progress (`isProcessing`)

## 6.2 Gemini Request

For each file:

1. PDF bytes -> base64
2. Build instruction text with system constraints + user prompt
3. POST to:

`https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={apiKey}`

Payload includes inline PDF data (`mimeType: application/pdf`) and `temperature: 0`.

## 6.3 Batching and Parallelism

- Files are chunked by `parallelBatchSize` (default 5)
- Each batch runs with `Promise.all` (full intra-batch parallelism)
- Batches run sequentially

This gives bounded concurrency while still improving throughput.

## 6.4 Retry Policy

`runGeminiExtractionWithRetry()` retries only on:

- `429`
- `5xx`

Retry delay is parsed from:

1. HTTP `retry-after` header
2. Gemini `RetryInfo.retryDelay`
3. regex parse from error message text
4. fallback default: `60000ms`

Max attempts = initial try + 3 retries.

## 6.5 Response Parsing

- Pull text from `candidates[0].content.parts[].text`
- Strip markdown fences if present
- Parse JSON object
- If valid object: normalize into `fields`
- If not parseable but text exists: fallback `{ model_output: text }`

Failures store `error` on that invoice; pipeline continues for remaining files.

## 7) UI Rendering Flow

`renderInvoice()` drives current card rendering:

- sets invoice header + filename
- toggles done checkbox
- calls `syncContextMenuFields(invoice)`
- renders mini page-1 preview (`renderPreview`)
- renders normalized field rows with copy buttons
- updates prev/next and progress dots

Mini preview is rendered with PDF.js at container-fit scale; clicking it opens full viewer.

## 8) Context Menu Paste Flow

1. Side panel computes current invoice fields (`buildContextMenuFields`) and stores `geminiContextMenuFields`.
2. Background watches storage changes and rebuilds context menu items.
3. User right-clicks editable input on target page, then chooses a field in `Invoice Clipper (Gemini)` submenu.
4. Background sends `{ action: "paste-field-value", value }` to content script.
5. Content script inserts text into last right-clicked editable node and dispatches events.

Important behavior: menu content is tied to *currently selected invoice* in side panel.

## 9) CSV Export

`buildInvoicesCsv()` exports columns:

- `Filename`
- `Done`
- `Error`
- one column per canonical field key present in dataset

Rows use CSV-safe escaping for commas/quotes/newlines.

## 10) Settings and Secrets

- API key is user-provided via settings modal and stored in `chrome.storage.local`.
- `sidepanel/gemini-config.js` can define defaults, but should not contain real secrets.
- If a key is compromised, rotate it in Google Cloud and update local settings.

## 11) Message Contracts

## 11.1 Side Panel -> Background

- `open-pdf-viewer` `{ filename }`

## 11.2 Background -> Content

- `paste-field-value` `{ value }`

## 11.3 Storage-driven

- `geminiContextMenuFields` change triggers full context menu rebuild

## 12) Extension Points

Common safe modifications:

- Add post-processing rules per field in `normalizeFieldMap()`.
- Add alternative export formats near `buildInvoicesCsv()` and `downloadTextFile()`.
- Add per-template prompts by extending `invoiceMeta` and settings schema.
- Add model/provider switch by abstracting `runGeminiExtraction()`.
- Add progress telemetry by instrumenting `processFiles()` batch loop.

## 13) Known Caveats

- Content script includes macro code not currently used by Gemini flow.
- `template-builder` and template storage are legacy modules retained from hybrid extension.
- Browser security generally prevents recovering guaranteed absolute local paths from uploaded files.
- Large batch size may increase rate-limit retries.

## 14) Local Dev and Manual Test Checklist

1. Load extension unpacked from this folder.
2. Open side panel and set API key in settings.
3. Enter prompt and upload multiple PDFs.
4. Verify:
   - extraction completes with progress messages
   - rerun button appears after prompt change
   - context menu values match current invoice
   - mini preview renders and opens full viewer
   - CSV export columns are normalized and stable
