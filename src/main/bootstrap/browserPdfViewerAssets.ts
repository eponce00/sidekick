export const BROWSER_PDF_VIEWER_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'self'; connect-src 'self'; worker-src 'self' blob:; img-src 'self' data: blob:; font-src 'self'">
    <title>PDF document</title>
    <link rel="stylesheet" href="./viewer.css">
  </head>
  <body>
    <header class="toolbar" aria-label="PDF controls">
      <div class="document-identity">
        <strong id="document-name">PDF document</strong>
        <span id="document-meta" aria-live="polite">Loading…</span>
      </div>
      <button id="save" type="button" disabled>Save filled copy</button>
    </header>
    <div id="status" class="status" role="status" aria-live="polite">Loading PDF…</div>
    <main id="pages" class="pages" aria-label="PDF pages"></main>
    <script type="module" src="./viewer.mjs"></script>
  </body>
</html>`

export const BROWSER_PDF_VIEWER_CSS = `
:root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
html, body { min-height: 100%; margin: 0; background: #15181d; color: #eef1f5; }
body { padding-top: 68px; }
.toolbar { position: fixed; z-index: 50; inset: 0 0 auto; min-height: 68px; display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 12px 24px; border-bottom: 1px solid #343942; background: rgba(20, 23, 28, .97); box-shadow: 0 8px 24px rgba(0,0,0,.2); }
.document-identity { min-width: 0; display: grid; gap: 3px; }
.document-identity strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; }
.document-identity span { color: #aeb5c0; font-size: 12px; }
button { appearance: none; border: 1px solid #6b92ff; border-radius: 9px; padding: 10px 15px; background: #3568f0; color: white; font: inherit; font-weight: 650; cursor: pointer; }
button:hover:not(:disabled) { background: #4678fa; }
button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible { outline: 3px solid rgba(93, 142, 255, .55); outline-offset: 2px; }
button:disabled { cursor: not-allowed; opacity: .5; }
.status { position: sticky; z-index: 40; top: 68px; padding: 8px 24px; border-bottom: 1px solid transparent; background: #20252d; color: #c7ced8; font-size: 13px; }
.status:empty { display: none; }
.status[data-kind="success"] { border-color: #246d4a; background: #173529; color: #a9efcb; }
.status[data-kind="error"] { border-color: #90404a; background: #3b2026; color: #ffc1c7; }
.pages { display: grid; justify-items: center; gap: 24px; padding: 28px 24px 56px; }
.page { position: relative; overflow: hidden; background: white; box-shadow: 0 12px 38px rgba(0,0,0,.42); }
.page > img { display: block; width: 100%; height: 100%; }
.form-layer { position: absolute; inset: 0; pointer-events: none; }
.pdf-field { position: absolute; min-width: 10px; min-height: 10px; margin: 0; border: 1px solid rgba(34, 91, 214, .72); border-radius: 2px; padding: 1px 3px; background: rgba(245, 249, 255, .94); color: #111827; font: 12px/1.2 Arial, sans-serif; pointer-events: auto; }
.pdf-field:hover { border-color: #144fc4; }
.pdf-field[readonly], .pdf-field:disabled { background: rgba(229, 231, 235, .9); }
input.pdf-field[type="checkbox"], input.pdf-field[type="radio"] { padding: 0; accent-color: #245bd7; }
.unsupported-field { position: absolute; overflow: hidden; border: 1px dashed #a06c00; background: rgba(255, 247, 214, .9); color: #4b3500; font: 10px/1.2 sans-serif; pointer-events: none; }
.semantic-text { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
`

export const BROWSER_PDF_VIEWER_MODULE = `
import * as pdfjs from './pdf.mjs';

let workerBlobUrl;

const pagesRoot = document.querySelector('#pages');
const status = document.querySelector('#status');
const saveButton = document.querySelector('#save');
const documentName = document.querySelector('#document-name');
const documentMeta = document.querySelector('#document-meta');
let pdfDocument;
let dirty = false;

function setStatus(message, kind = '') {
  status.textContent = message;
  status.dataset.kind = kind;
}

function fieldLabel(annotation) {
  return annotation.alternativeText || annotation.fieldName || 'PDF form field';
}

function viewportBox(viewport, rect) {
  const first = viewport.convertToViewportPoint(rect[0], rect[1]);
  const second = viewport.convertToViewportPoint(rect[2], rect[3]);
  const left = Math.min(first[0], second[0]);
  const top = Math.min(first[1], second[1]);
  return {
    left,
    top,
    width: Math.max(10, Math.abs(second[0] - first[0])),
    height: Math.max(10, Math.abs(second[1] - first[1]))
  };
}

function positionField(element, box) {
  element.classList.add('pdf-field');
  element.style.left = box.left + 'px';
  element.style.top = box.top + 'px';
  element.style.width = box.width + 'px';
  element.style.height = box.height + 'px';
}

function optionValue(option) {
  return String(option.exportValue ?? option.displayValue ?? '');
}

function createField(annotation, viewport) {
  if (!annotation.rect || !annotation.fieldName) return null;
  const label = fieldLabel(annotation);
  const current = annotation.fieldValue;
  let element;

  if (annotation.fieldType === 'Tx') {
    element = document.createElement(annotation.multiLine ? 'textarea' : 'input');
    if (element instanceof HTMLInputElement) element.type = annotation.password ? 'password' : 'text';
    element.value = current == null ? '' : String(current);
    if (annotation.maxLen) element.maxLength = annotation.maxLen;
  } else if (annotation.fieldType === 'Ch') {
    element = document.createElement('select');
    element.multiple = Boolean(annotation.multiSelect);
    for (const option of annotation.options || []) {
      const node = document.createElement('option');
      node.value = optionValue(option);
      node.textContent = String(option.displayValue ?? option.exportValue ?? '');
      const selected = Array.isArray(current)
        ? current.map(String).includes(node.value)
        : String(current ?? '') === node.value;
      node.selected = selected;
      element.append(node);
    }
  } else if (annotation.fieldType === 'Btn' && (annotation.checkBox || annotation.radioButton)) {
    element = document.createElement('input');
    element.type = annotation.radioButton ? 'radio' : 'checkbox';
    element.name = annotation.fieldName;
    element.value = String(annotation.buttonValue || annotation.exportValue || 'Yes');
    element.checked = String(current ?? '') === element.value || current === true;
  } else {
    const unsupported = document.createElement('div');
    unsupported.className = 'unsupported-field';
    unsupported.textContent = label;
    const box = viewportBox(viewport, annotation.rect);
    Object.assign(unsupported.style, {
      left: box.left + 'px', top: box.top + 'px', width: box.width + 'px', height: box.height + 'px'
    });
    return unsupported;
  }

  const accessibleLabel =
    element instanceof HTMLInputElement && element.type === 'radio'
      ? label + ': ' + element.value
      : label;
  element.setAttribute('aria-label', accessibleLabel);
  element.dataset.annotationId = annotation.id;
  element.dataset.fieldName = annotation.fieldName;
  element.disabled = Boolean(annotation.readOnly);
  positionField(element, viewportBox(viewport, annotation.rect));

  const synchronize = () => {
    let value;
    if (element instanceof HTMLSelectElement) {
      const selected = [...element.selectedOptions].map((option) => option.value);
      value = element.multiple ? selected : (selected[0] ?? '');
    } else if (element instanceof HTMLInputElement && element.type === 'checkbox') {
      value = element.checked ? element.value : 'Off';
    } else if (element instanceof HTMLInputElement && element.type === 'radio') {
      if (!element.checked) return;
      value = element.value;
    } else {
      value = element.value;
    }
    pdfDocument.annotationStorage.setValue(annotation.id, { value });
    dirty = true;
    saveButton.disabled = false;
    setStatus('Unsaved form changes');
  };
  element.addEventListener('input', synchronize);
  element.addEventListener('change', synchronize);
  return element;
}

async function renderPage(pageNumber) {
  setStatus('Rendering page ' + pageNumber + '…');
  const page = await pdfDocument.getPage(pageNumber);
  setStatus('Painting page ' + pageNumber + '…');
  const baseViewport = page.getViewport({ scale: 1 });
  const available = Math.max(640, Math.min(1040, window.innerWidth - 64));
  const scale = Math.min(1.65, available / baseViewport.width);
  const viewport = page.getViewport({ scale });
  const outputScale = Math.min(2, window.devicePixelRatio || 1);
  const section = document.createElement('section');
  section.className = 'page';
  section.setAttribute('aria-label', 'Page ' + pageNumber);
  section.style.width = viewport.width + 'px';
  section.style.height = viewport.height + 'px';

  const pageImage = document.createElement('img');
  pageImage.alt = '';
  pageImage.decoding = 'async';
  pageImage.src = './page-' + pageNumber + '.png?scale=' + (scale * outputScale);
  section.append(pageImage);
  pagesRoot.append(section);
  await new Promise((resolve, reject) => {
    pageImage.addEventListener('load', resolve, { once: true });
    pageImage.addEventListener('error', () => reject(new Error('Could not render page ' + pageNumber)), { once: true });
  });

  setStatus('Reading text on page ' + pageNumber + '…');
  const semanticText = document.createElement('div');
  semanticText.className = 'semantic-text';
  semanticText.setAttribute('role', 'document');
  semanticText.setAttribute('aria-label', 'Text on page ' + pageNumber);
  const text = await page.getTextContent();
  semanticText.textContent = text.items.map((item) => item.str || '').join(' ').trim();
  section.append(semanticText);

  setStatus('Reading form fields on page ' + pageNumber + '…');
  const formLayer = document.createElement('div');
  formLayer.className = 'form-layer';
  formLayer.setAttribute('aria-label', 'Form fields on page ' + pageNumber);
  const annotations = await page.getAnnotations({ intent: 'display' });
  for (const annotation of annotations) {
    const field = createField(annotation, viewport);
    if (field) formLayer.append(field);
  }
  section.append(formLayer);
  return formLayer.querySelectorAll('.pdf-field').length;
}

saveButton.addEventListener('click', async () => {
  if (!pdfDocument || !dirty) return;
  saveButton.disabled = true;
  setStatus('Saving filled copy…');
  try {
    const bytes = await pdfDocument.saveDocument();
    const response = await fetch('./save', {
      method: 'POST',
      headers: { 'content-type': 'application/pdf' },
      body: bytes
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not save the filled PDF');
    dirty = false;
    document.documentElement.dataset.sidekickPdfSaved = 'true';
    document.documentElement.dataset.sidekickPdfOutput = result.outputPath;
    setStatus('Filled copy saved: ' + result.outputPath, 'success');
  } catch (error) {
    saveButton.disabled = false;
    setStatus(error instanceof Error ? error.message : String(error), 'error');
  }
});

async function main() {
  try {
    const metadataResponse = await fetch('./metadata.json');
    if (!metadataResponse.ok) throw new Error('PDF session is no longer available');
    const metadata = await metadataResponse.json();
    documentName.textContent = metadata.name;
    document.title = metadata.name;
    setStatus('Reading PDF…');
    const pdfResponse = await fetch('./document.pdf');
    if (!pdfResponse.ok) throw new Error('Could not read the PDF document');
    const pdfBytes = new Uint8Array(await pdfResponse.arrayBuffer());
    setStatus('Starting PDF renderer…');
    const workerResponse = await fetch('./pdf.worker.mjs');
    if (!workerResponse.ok) throw new Error('Could not load the PDF renderer worker');
    workerBlobUrl = URL.createObjectURL(new Blob([await workerResponse.text()], { type: 'text/javascript' }));
    const workerPort = new Worker(workerBlobUrl, { type: 'module', name: 'sidekick-pdf-renderer' });
    const worker = new pdfjs.PDFWorker({ port: workerPort });
    const task = pdfjs.getDocument({ data: pdfBytes, worker, isEvalSupported: false });
    pdfDocument = await task.promise;
    setStatus('Rendering pages…');
    let fieldCount = 0;
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
      fieldCount += await renderPage(pageNumber);
    }
    documentMeta.textContent = pdfDocument.numPages + (pdfDocument.numPages === 1 ? ' page' : ' pages') + ' · ' + fieldCount + (fieldCount === 1 ? ' form field' : ' form fields');
    saveButton.hidden = fieldCount === 0;
    setStatus(fieldCount ? 'Ready — fill fields, then save a copy' : 'Ready — this PDF has no interactive form fields');
    document.documentElement.dataset.sidekickPdfReady = 'true';
  } catch (error) {
    console.error(error);
    documentMeta.textContent = 'Could not render';
    setStatus(error instanceof Error ? error.message : String(error), 'error');
    document.documentElement.dataset.sidekickPdfError = 'true';
  }
}

main();
`
