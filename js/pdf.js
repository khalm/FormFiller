// Shared PDF library setup (all files are bundled locally so the app works offline).
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';
export * as PDFLib from '../vendor/pdf-lib.esm.min.js';

const base = new URL('../vendor/pdfjs/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.mjs';

export { pdfjsLib };

export function openPdf(bytes, password) {
  return pdfjsLib.getDocument({
    data: bytes.slice(0), // pdf.js transfers the buffer, keep our own copy intact
    password,
    isEvalSupported: false,
    enableXfa: false,
    standardFontDataUrl: base + 'standard_fonts/',
    cMapUrl: base + 'cmaps/',
    cMapPacked: true,
    wasmUrl: base + 'wasm/',
    iccUrl: base + 'iccs/',
  });
}
