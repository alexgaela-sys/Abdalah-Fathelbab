// F19 — printing / PDF helper.
//
// The whole application must NOT be printed. `printDocument()` scopes the print
// output to a single `.print-area` element (invoice, report, statement, item
// card) by tagging <body> for the duration of the print job; the @media print
// block in src/index.css then hides every other node on the page.
//
// Browser "Save as PDF" is used deliberately: no heavy PDF dependency.
export function printDocument(): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const cleanup = () => document.body.classList.remove('print-only-doc');
  document.body.classList.add('print-only-doc');
  window.addEventListener('afterprint', cleanup, { once: true });
  window.print();
  // Safari/older engines do not always fire afterprint.
  window.setTimeout(cleanup, 1500);
}
