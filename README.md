# Invoice Clipper (Gemini Copy)

This is a copy of `sima-extension-hybrid` rewritten to use Gemini for PDF extraction.

## How it works
- User provides one input: an extraction prompt in the sidepanel.
- User uploads one or more PDF invoices.
- Extension sends `prompt + PDF` to Gemini and expects JSON output.
- Results can be copied per field and exported to CSV.

## Setup
1. Open `sidepanel/gemini-config.js`.
2. Set `GEMINI_API_KEY`.
3. Optionally change `GEMINI_MODEL`.
4. Load this folder as an unpacked extension in Chrome.

## Notes
- Gemini endpoint permission is already in `manifest.json`.
- CSV includes `Filename`, `Filepath` (best available), `Done`, `Error`, and extracted fields.
