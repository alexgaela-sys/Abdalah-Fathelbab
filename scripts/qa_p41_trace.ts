// QA — P41 RESIDUAL TRACER (read-only investigation harness).
//
// Run: `bun run qa_p41_trace`
//
// PURPOSE
// Re-runs the UNMODIFIED `scripts/qa_break_test2.ts` (qa2) under instrumentation so
// that every service call is measured as ΔGL-inventory vs Δbatch-ledger, per
// warehouse, and the residual is reported transaction-by-transaction.
//
// It answers one question: which transaction first introduces the P41 divergence,
// and is that transaction journal-less by design (harness tracker must absorb it)
// or is it an application defect (a journal that should exist and does not).
//
// HOW (no application source is modified)
// qa2 is imported dynamically AFTER the service classes have been wrapped, so the
// wrapper observes every real call qa2 makes. The wrapper is generic: it patches
// every static method of every ERP service class.
//
// NOTHING IS MUTATED BY THIS FILE ITSELF: it only reads snapshots. qa2's own
// cleanup still runs (TEST-QA-prefixed records only, no reset/reseed).
import { erpDb } from '../src/services/db';
import { InventoryEngine } from '../src/services/inventory';
import { WorkflowService } from '../src/services/workflows';
import { ManufacturingEngine } from '../src/services/manufacturing';
import { AccountingEngine } from '../src/services/accounting';
import { MasterDataService } from '../src/services/masterData';

const WH_ACC: Record<string, string> = {
  'wh-raw': '1108', 'wh-local': '1109', 'wh-export': '1110',
  'wh-damaged': '1111', 'wh-scrap': '1112',
};
const snap = () => erpDb.getSnapshot();
const acc = (code: string) => snap().accounts.find(a => a.code === code)?.currentBalance || 0;

function state() {
  const db = snap();
  const batch: Record<string, number> = {};
  let batchTotal = 0;
  for (const b of db.batches) {
    const v = b.quantity * (b.unitCost || 0);
    batch[b.warehouseId] = (batch[b.warehouseId] || 0) + v;
    batchTotal += v;
  }
  const gl: Record<string, number> = {};
  for (const [wh, code] of Object.entries(WH_ACC)) gl[wh] = acc(code);
  return { batch, batchTotal, gl, glTotal: Object.values(gl).reduce((a, b) => a + b, 0) + acc('1107') };
}

/** Value moved into a warehouse's batch ledger with NO matching GL movement. */
const injected: Record<string, number> = {};
let seq = 0;
let depth = 0;
let lastRaw: Record<string, number> = {};

console.log('================================================================');
console.log('🔬 P41 RESIDUAL TRACER — wrapping ERP services, then running qa2 unchanged');
console.log('================================================================');

const base = state();
for (const [wh, code] of Object.entries(WH_ACC)) {
  lastRaw[wh] = base.gl[wh] - (base.batch[wh] || 0);
  console.log(`  baseline ${wh.padEnd(11)} GL${code} ${base.gl[wh].toFixed(2).padStart(12)}  batches ${(base.batch[wh] || 0).toFixed(2).padStart(12)}  rawΔ ${lastRaw[wh].toFixed(2)}`);
}
console.log(`  baseline inventory GL total ${base.glTotal.toFixed(2)}  batch total ${base.batchTotal.toFixed(2)}`);

function wrap(name: string, obj: unknown) {
  const cls = obj as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(cls)) {
    if (key === 'constructor' || key === 'prototype' || key === 'length' || key === 'name') continue;
    const orig = cls[key];
    if (typeof orig !== 'function') continue;
    if ((orig as { __qaP41?: boolean }).__qaP41) continue;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      // Only the OUTERMOST service call (the transaction qa2 actually issued) is
      // logged; nested calls are already contained in the outer delta.
      if (depth > 0) return (orig as (...a: unknown[]) => unknown).apply(this, args);
      depth++;
      const s0 = state();
      let out: unknown;
      let err = '';
      try { out = (orig as (...a: unknown[]) => unknown).apply(this, args); }
      catch (e) { err = ` [threw: ${(e as Error).message}]`; }
      const s1 = state();
      depth--;
      for (const [wh, code] of Object.entries(WH_ACC)) {
        const dBatch = (s1.batch[wh] || 0) - (s0.batch[wh] || 0);
        const dGl = s1.gl[wh] - s0.gl[wh];
        if (Math.abs(dBatch) < 0.005 && Math.abs(dGl) < 0.005) continue;
        // A movement with no GL counterpart is journal-less BY CONSTRUCTION:
        // recordMovement/transfer primitives never post. Track it as injected.
        const journalLess = Math.abs(dGl) < 0.005;
        if (journalLess) injected[wh] = (injected[wh] || 0) + dBatch;
        const raw = s1.gl[wh] - (s1.batch[wh] || 0);
        const shift = raw - lastRaw[wh];
        lastRaw[wh] = raw;
        seq++;
        console.log(
          `  #${String(seq).padStart(3)} ${(name + '.' + key).padEnd(34)} ${wh.padEnd(11)}` +
          ` ΔGL${code} ${dGl.toFixed(2).padStart(12)}  Δbatch ${dBatch.toFixed(2).padStart(12)}` +
          `  ${journalLess ? 'JOURNAL-LESS' : 'journal   '}  rawΔ ${raw.toFixed(2).padStart(12)}` +
          `  (shift ${shift.toFixed(2).padStart(10)})  injected ${(injected[wh] || 0).toFixed(2).padStart(11)}${err}`,
        );
      }
      return out;
    };
    (wrapped as { __qaP41?: boolean }).__qaP41 = true;
    cls[key] = wrapped;
  }
}

wrap('InventoryEngine', InventoryEngine);
wrap('WorkflowService', WorkflowService);
wrap('ManufacturingEngine', ManufacturingEngine);
wrap('AccountingEngine', AccountingEngine);
wrap('MasterDataService', MasterDataService);

// qa2 exits non-zero when it finds defects; neutralise the exit so the tracer can
// still print its own verdict afterwards. The real exit code is replayed below.
let capturedExit: number | null = null;
const realExit = process.exit.bind(process);
process.exit = ((code?: number) => { capturedExit = code ?? 0; }) as never;

import('./qa_break_test2').then(
  () => {
    console.log('\n================================================================');
    console.log('P41 TRACER VERDICT');
    console.log('================================================================');
    const end = state();
    let totRaw = 0;
    for (const [wh, code] of Object.entries(WH_ACC)) {
      const raw = end.gl[wh] - (end.batch[wh] || 0);
      totRaw += raw;
      console.log(`  ${wh.padEnd(11)} GL${code} ${end.gl[wh].toFixed(2).padStart(12)}  batches ${(end.batch[wh] || 0).toFixed(2).padStart(12)}  rawΔ ${raw.toFixed(2).padStart(10)}  injected ${(injected[wh] || 0).toFixed(2).padStart(11)}  corrected ${(raw + (injected[wh] || 0)).toFixed(2)}`);
    }
    const injTotal = Object.values(injected).reduce((a, b) => a + b, 0);
    console.log(`  Σ rawΔ (5 warehouses)          ${totRaw.toFixed(2)}`);
    console.log(`  Σ injected (journal-less)      ${injTotal.toFixed(2)}`);
    console.log(`  batchTotal ${end.batchTotal.toFixed(2)}  glInventoryTotal ${end.glTotal.toFixed(2)}`);
    console.log(`  qa2 exit code: ${capturedExit}`);
    process.exit = realExit;
    process.exit(capturedExit ?? 0);
  },
  (e) => { console.error('tracer: qa2 threw', e); process.exit = realExit; process.exit(1); },
);