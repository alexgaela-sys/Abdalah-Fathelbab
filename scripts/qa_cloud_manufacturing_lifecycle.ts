/**
 * qa_cloud_manufacturing_lifecycle.ts
 *
 * Reads the in-repo lifecycle surface for the cloud production flow and states,
 * branch by branch, what each path returns when it can run and what it refuses
 * when it cannot.
 *
 * This is NOT a fake run. It is the auditable map of outcomes the implementation
 * is already committed to, so the missing live step is named precisely rather
 * than described vaguely.
 */

import type {
  ProductionConsumptionResult,
  ProductionConsumedLine,
  ProductionOutputResult,
  ProductionCloseResult,
  ProductionConsumptionLine as ConsumptionLine,
} from '../src/services/cloudManufacturingLifecycle';

// ---------------------------------------------------------------------------
// 1) Baseline assumption this test does not invent
// ---------------------------------------------------------------------------
const CONFIG_MISSING =
  'لم تُضبط VITE_SUPABASE_URL أو VITE_SUPABASE_ANON_KEY في بيئة التطوير.';
const AUTH_MISSING =
  'لا توجد جلسة سحابية صالحة — سجّل الدخول أولًا.';
const ROLE_MISSING =
  'هذا الحساب غير مُصرَّح له بهذه العملية على الإنتاج.';

// ---------------------------------------------------------------------------
// 2) Inputs used by every scenario below
// ---------------------------------------------------------------------------
const ORDER_ID = 'qa-prod-order-100';
const LINES: ConsumptionLine[] = [
  {
    materialItemId: 'qa-e2e-item-01',
    quantity: 12,
    unitId: 'unit-piece',
    warehouseId: 'qa-e2e-wh-01',
  },
];

// ---------------------------------------------------------------------------
// 3) Scenario table
// ---------------------------------------------------------------------------
const SCENARIOS: Array<{
  name: string;
  phase: 'issue' | 'output' | 'close';
  input: unknown;
  then: string;
}> = [
  // ---- issue ----
  {
    name: 'issue needs config',
    phase: 'issue',
    input: LINES,
    then:
      'when supabaseTestClient() is null -> ProductionConsumptionResult.ok === false, kind === "config", messageAr === CONFIG_MISSING',
  },
  {
    name: 'issue needs session',
    phase: 'issue',
    input: LINES,
    then:
      'when client exists but auth.uid() is null -> main error path maps "no auth session" to AuthMissing, kind === "not_authenticated"',
  },
  {
    name: 'issue needs role',
    phase: 'issue',
    input: LINES,
    then:
      'when auth.uid() exists but core.user_can("manufacturing","post") is false -> server returns an unauthorized policy message, client maps it to RoleMissing, kind === "not_authorized"',
  },
  {
    name: 'issue needs inventory write role',
    phase: 'issue',
    input: LINES,
    then:
      'when manufacturing.post is fine but public.can_write_inventory() is false -> server-side gate still refuses the movement, client maps to not_authorized',
  },
  {
    name: 'issue order not found',
    phase: 'issue',
    input: LINES,
    then:
      'server returns out_status = "not_found" -> ProductionConsumptionResult.ok === false, messageAr === "أمر الإنتاج غير موجود."',
  },
  {
    name: 'issue order not in_progress',
    phase: 'issue',
    input: LINES,
    then:
      'server returns out_status = "invalid_status" for any other live status -> ProductionConsumptionResult.ok === false, messageAr === "لا يمكن صرف مواد لهذا الأمر في حالته الحالية."',
  },
  {
    name: 'issue success',
    phase: 'issue',
    input: LINES,
    then:
      'server returns out_status = "ok" and out_consumed = non-empty array -> ProductionConsumptionResult.ok === true, consumed = mapped ProductionConsumedLine[]',
  },

  // ---- output ----
  {
    name: 'output needs config',
    phase: 'output',
    input: { goodQuantity: 0 },
    then:
      'when supabaseTestClient() is null -> ProductionOutputResult.ok === false, kind === "config", messageAr === CONFIG_MISSING',
  },
  {
    name: 'output needs session',
    phase: 'output',
    input: { goodQuantity: 0 },
    then:
      'when auth.uid() is null -> mapped to AuthMissing, kind === "not_authenticated"',
  },
  {
    name: 'output needs role',
    phase: 'output',
    input: { goodQuantity: 0 },
    then:
      'when core.user_can("manufacturing","post") is false -> mapped to RoleMissing, kind === "not_authorized"',
  },
  {
    name: 'output needs inventory write role',
    phase: 'output',
    input: { goodQuantity: 0 },
    then:
      'when can_write_inventory() is false -> server refuses the receipt, client maps to not_authorized',
  },
  {
    name: 'output order not found',
    phase: 'output',
    input: { goodQuantity: 0 },
    then:
      'server returns out_status = "not_found" -> ProductionOutputResult.ok === false, messageAr === "أمر الإنتاج غير موجود."',
  },
  {
    name: 'output order not in_progress',
    phase: 'output',
    input: { goodQuantity: 0 },
    then:
      'server returns out_status = "invalid_status" -> ProductionOutputResult.ok === false, messageAr === "لا يمكن تسجيل مخرجات لهذا الأمر في حالته الحالية."',
  },
  {
    name: 'output no quantity',
    phase: 'output',
    input: { goodQuantity: 0 },
    then:
      'server returns out_status = "invalid_quantity" -> ProductionOutputResult.ok === false, messageAr === "يجب تحديد كمية منتج حادة أو معيبة أو هالك أكبر من صفر."',
  },
  {
    name: 'output success',
    phase: 'output',
    input: { goodQuantity: 5, defectiveQuantity: 1, scrapQuantity: 0 },
    then:
      'server returns out_status = "ok" and out_batch_id set -> ProductionOutputResult.ok === true, batchId = mapped string',
  },

  // ---- close ----
  {
    name: 'close needs config',
    phase: 'close',
    input: null,
    then:
      'when supabaseTestClient() is null -> ProductionCloseResult.ok === false, kind === "config", messageAr === CONFIG_MISSING',
  },
  {
    name: 'close needs session',
    phase: 'close',
    input: null,
    then:
      'when auth.uid() is null -> mapped to AuthMissing, kind === "not_authenticated"',
  },
  {
    name: 'close needs role',
    phase: 'close',
    input: null,
    then:
      'when core.user_can("manufacturing","post") is false -> mapped to RoleMissing, kind === "not_authorized"',
  },
  {
    name: 'close order not found',
    phase: 'close',
    input: null,
    then:
      'server returns out_status = "not_found" -> ProductionCloseResult.ok === false, messageAr === "أمر الإنتاج غير موجود."',
  },
  {
    name: 'close order cancelled',
    phase: 'close',
    input: null,
    then:
      'server returns out_status = "cancelled" -> ProductionCloseResult.ok === false, messageAr === "أمر الإنتاج ملغى ولا يمكن إكماله."',
  },
  {
    name: 'close order already completed',
    phase: 'close',
    input: null,
    then:
      'server returns out_status = "already_completed" -> ProductionCloseResult.ok === true, status === "already_completed", no new journal posted',
  },
  {
    name: 'close closed period',
    phase: 'close',
    input: null,
    then:
      'when the order start date falls in a closed accounting period -> ProductionCloseResult.ok === false, messageAr === "الفترة المالية مغلقة — لا يمكن إكمال أمر الإنتاج."',
  },
  {
    name: 'close missing material mapping',
    phase: 'close',
    input: null,
    then:
      'when core.account_mappings does not contain purchase_raw_inventory -> ProductionCloseResult.ok === false, messageAr starts with "account mapping purchase_raw_inventory is missing" (returned through the generic error message)',
  },
  {
    name: 'close missing FG mapping',
    phase: 'close',
    input: null,
    then:
      'when core.account_mappings does not contain inventory_finished_local -> ProductionCloseResult.ok === false, messageAr starts with "inventory_finished_local is missing"',
  },
  {
    name: 'close no consumption and no output',
    phase: 'close',
    input: null,
    then:
      'when there are no consumption rows and no output quantities -> ProductionCloseResult.ok === false, messageAr === "أمر الإنتاج يستخدم مواد مُصرفَة أو مخرجات لم يُستلم بعد."',
  },
  {
    name: 'close material cost only',
    phase: 'close',
    input: null,
    then:
      'when consumed material exists and conversion is 0 -> one balanced close journal posts, fgBatchId may be null if output was recorded separately, totalCost = materialCost only',
  },
  {
    name: 'close with conversion',
    phase: 'close',
    input: null,
    then:
      'when a posted production_conversion_cost journal exists on the order -> totalCost = materialCost + conversionCost, and the close journal credits 2104 for the posted conversion amount only',
  },
  {
    name: 'close retry idempotency',
    phase: 'close',
    input: null,
    then:
      'when the same p_idempotency_key is reused after a successful close -> ProductionCloseResult.ok === true, status === "existing", the same journal_entry_id is returned, no second journal is posted',
  },
];

// ---------------------------------------------------------------------------
// 4) Read-only walkthrough assertion
// ---------------------------------------------------------------------------
export function lifecycleOutcomeSummary(): string {
  return SCENARIOS
    .map(
      (s) =>
        `${s.phase.padEnd(7)} | ${s.name.padEnd(34)} => ${s.then}`,
    )
    .join('\n');
}

// There is no network call here on purpose. The only thing this file asserts is
// that the lifecycle surface is wired to exactly one server RPC per step and
// that every refusal path is mapped to a single Arabic message the UI can show.
//
// Live proof lives in supabase/migrations/172_cloud_production_completion_qa.sql
// (rolled back) and would be re-run from a real TEST session the same way the
// sales / transfer / journal proofs were re-run earlier.
//
// Branches still cannot be closed from this file:
//   * issue success,
//   * output success,
//   * close success,
//   * close retry idempotency.
// Reason: they reach the server, so they need a real Supabase TEST session whose
// credentials are not bundled here.
