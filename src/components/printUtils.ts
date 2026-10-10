// F19 — printing / PDF helper.
//
// The whole application must NOT be printed. `printDocument()` scopes the print
// output to a single `.print-area` element (invoice, report, statement, item
// card) by tagging <body> for the duration of the print job; the @media print
// block in src/index.css then hides every other node on the page.
//
// Browser "Save as PDF" is used deliberately: no heavy PDF dependency.
//
// Returns `true` when the browser was actually asked to print and `false` when
// the print entry point is unavailable or throws — so callers can tell the user
// instead of appearing to do nothing.
export function printDocument(): boolean {
  if (typeof document === 'undefined' || typeof window === 'undefined') return false;
  if (typeof window.print !== 'function') return false;

  const body = document.body;
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    body.classList.remove('print-only-doc');
    window.removeEventListener('afterprint', cleanup);
    window.removeEventListener('pagehide', cleanup);
  };

  body.classList.add('print-only-doc');
  // The scope is released ONLY when the print job is really finished. A short
  // timer here used to strip the class while the browser's print preview was
  // still open, so the preview re-rendered the whole application (or an empty
  // page) instead of the document. `afterprint` is the authoritative signal;
  // `pagehide` plus a long guard only cover engines that never fire it.
  window.addEventListener('afterprint', cleanup);
  window.addEventListener('pagehide', cleanup);
  window.setTimeout(cleanup, 5 * 60 * 1000);

  try {
    window.print();
  } catch {
    cleanup();
    return false;
  }
  return true;
}
