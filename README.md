# FormFiller

Fill out any PDF form — free, private, and right in your browser.

**Use it:** https://khalm.github.io/FormFiller/

1. Choose a PDF (or share one to the app from your phone).
2. FormFiller finds the boxes and shows you the PDF. Tap a box — the keyboard opens and you type straight into the PDF. Use **‹ ›** to jump from box to box.
3. Save — either the **entire PDF** or **only the pages with the form**.

Prefer a simple list of questions instead? Switch to the **List** tab.

## What it can do

- **Fillable PDFs** (with real form fields): text, multi-line, checkboxes, radio buttons, dropdowns, lists and date fields. Labels are taken from the field's tooltip or the text printed next to / above / under the field.
- **Printed-style PDFs** (no real fields): finds blank lines, underscores (`Name: ______`), empty boxes, table cells, checkbox squares and `Label:` blanks automatically. Drag the blue dots on a box to, resize, remove or add fields.
- **Signatures**: draw with your finger, or type instead.
- **Save options**: entire PDF or only the form pages, optionally **locked** (flattened) so answers can't be changed.
- **Password-protected and owner-protected PDFs** are supported.
- **Remembers** your unfinished answers per document, and suggests answers you've used before (stored only on your device).
- **Works offline** and can be installed as an app (Android: “Install app”, then share PDFs directly to FormFiller).
- English and Norwegian.

Nothing is ever uploaded — all PDF processing happens on your device.

## Tech

Plain HTML/CSS/JS, no build step. Uses [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0) for reading, field detection and filling, and [pdf-lib](https://github.com/Hopding/pdf-lib) (MIT) for drawing, locking and page selection. Both are bundled in `vendor/`.

- `js/detect.js` – field detection (form fields + visual detection of printed forms)
- `js/fill.js` – writes answers into the PDF
- `js/app.js` – user interface
- `js/version.js` – app version (shown on the front page)

## Publishing

Settings → Pages → Build and deployment → Source: **Deploy from a branch**, Branch: **main**, folder **/ (root)**.
