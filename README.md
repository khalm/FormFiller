# FormFiller

Fill out any PDF form — free, private, and right in your browser.

**Use it:** https://khalm.github.io/FormFiller/

1. Choose a PDF (or share one to the app from your phone).
2. FormFiller finds the boxes and shows you the PDF. Tap a box — the keyboard opens and you type straight into the PDF. Use **‹ ›** to jump from box to box.
3. Save — either the **entire PDF** or **only the pages with the form**.

Pinch with two fingers to zoom and move two fingers to pan — this works in every mode.

Prefer a simple list of questions instead? Switch to the **List** tab.

## What it can do

- **Fillable PDFs** (with real form fields): text, multi-line, checkboxes, radio buttons, dropdowns, lists and date fields. Labels are taken from the field's tooltip or the text printed next to / above / under the field.
- **Printed-style PDFs** (no real fields): finds blank lines, underscores (`Name: ______`), empty boxes, table cells, checkbox squares and `Label:` blanks automatically. Drag the blue dots on a box to move or resize it, tap ＋ to add a box, or remove ones you don't need.
- **Merge boxes**: select several boxes and join them, either as one text spanning them all or one letter per box (great for number boxes).
- **Erase** existing text: tap a word or drag over an area, then pick a style — strike out (1, 2 or 3 lines), scribble, hatching, blur, or cover up (automatic page colour, presets, any colour or a pipette that picks a colour from the page). Tap a mark to move, resize, delete it or change its style/colour. Also works on text that other apps added on top of the page, and **Type here** puts a new text box right over what you erased. The original text is still inside the file, so don't use it to hide secrets.
- **Undo / redo** for everything: typing, ticks, erase marks, adding, moving, merging and removing boxes.
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
