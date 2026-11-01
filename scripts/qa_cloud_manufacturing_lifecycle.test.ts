/**
 * qa_cloud_manufacturing_lifecycle.test.ts
 *
 * EXECUTABLE test for the cloud production client surface (no network).
 *
 * What it proves: every server status the production RPCs can return is mapped
 * to exactly one UI result, that costs are derived from the server numbers
 * (material + conversion = total), and that the RPC parameters sent are the
 * documented contract.
 *
 * What it does NOT prove (and must not be reported as proven): that the server
 * RPCs themselves compute FIFO consumption, FG receipt and a balanced journal.
 * Those need a live Supabase TEST session with a valid anon key.
 *
 * Run: bun test scripts/qa_cloud_manufacturing_lifecycle.test.ts
 */
import { mock, describe, expect, test } from 'bun:test';

type RpcCall = { name: string; params: Record<string, unknown> };
type RpcReply = { data: unknown; error: { message: string } | null };

let mode: 'live' | 'missing' = 'live';
let reply: RpcReply = { data: null, error: null };
const calls: RpcCall[] = [];

mock.module('../src/services/supabaseTestClient.ts', () => ({
  supabaseTestClient: () =>
    mode === 'missing'
      ? null
      : {
          rpc: async (name: string, params: Record<string, unknown>) => {
            calls.push({ name, params });
            return reply;
          },
        },
  SUPABASE_TEST_USER_EMAIL: 'qa@example.invalid',
}));

const lifecycle = await import('../src/services/cloudManufacturingLifecycle');

const reset = () => {
  calls.length = 0;
  mode = 'live';
  reply = { data: null, error: null };
};

const CONFIG_MESSAGE = 'لم تُضبط VITE_SUPABASE_URL أو VITE_SUPABASE_ANON_KEY في بيئة التطوير.';
const ORDER = 'ord-qa-1';

describe('issueProductionConsumption', () => {
  test('no client -> config failure, no RPC call', async () => {
    reset();
    mode = 'missing';
    const res = await lifecycle.issueProductionConsumption(ORDER, []);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.kind).toBe('config');
    expect(res.messageAr).toBe(CONFIG_MESSAGE);
    expect(calls).toHaveLength(0);
  });

  test('server error text is mapped to auth / role / network', async () => {
    reset();
    reply = { data: null, error: { message: 'JWT expired' } };
    let res = await lifecycle.issueProductionConsumption(ORDER, []);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe('not_authenticated');

    reset();
    reply = { data: null, error: { message: 'permission denied for function create_production_consumption' } };
    res = await lifecycle.issueProductionConsumption(ORDER, []);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe('not_authorized');

    reset();
    reply = { data: null, error: { message: 'socket hang up' } };
    res = await lifecycle.issueProductionConsumption(ORDER, []);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe('network');
  });

  test('status ok maps consumed lines and sends the documented params', async () => {
    reset();
    reply = {
      data: {
        out_status: 'ok',
        out_success: true,
        out_consumed: [{ materialItemId: 'mat-1', quantity: 12, warehouseId: 'wh-raw' }],
      },
      error: null,
    };
    const res = await lifecycle.issueProductionConsumption(ORDER, [
      { materialItemId: 'mat-1', quantity: 12, unitId: 'unit-piece', warehouseId: 'wh-raw' },
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.consumed).toEqual([{ materialItemId: 'mat-1', quantity: 12, warehouseId: 'wh-raw' }]);

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('create_production_consumption');
    expect(calls[0].params.p_order_id).toBe(ORDER);
    expect(calls[0].params.p_lines).toEqual([
      { materialItemId: 'mat-1', quantity: 12, unitId: 'unit-piece', warehouseId: 'wh-raw' },
    ]);
    expect(String(calls[0].params.p_idempotency_key)).toStartWith('ui-prod-consume-');
  });

  test('refusals carry one Arabic message per status', async () => {
    reset();
    reply = { data: { out_status: 'invalid_status' }, error: null };
    const res = await lifecycle.issueProductionConsumption(ORDER, []);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.messageAr).toBe('لا يمكن صرف مواد لهذا الأمر في حالته الحالية.');

    reset();
    reply = { data: { out_status: 'not_found' }, error: null };
    const nf = await lifecycle.issueProductionConsumption(ORDER, []);
    expect(nf.ok).toBe(false);
    if (!nf.ok) expect(nf.messageAr).toBe('أمر الإنتاج غير موجود.');
  });

  test('insufficient stock surface: server rejects, nothing is silently accepted', async () => {
    reset();
    reply = { data: null, error: { message: 'insufficient stock for material mat-1: available 3 < required 12' } };
    const res = await lifecycle.issueProductionConsumption(ORDER, [{ materialItemId: 'mat-1', quantity: 12 }]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.messageAr).toContain('insufficient stock');
  });
});

describe('recordProductionOutput', () => {
  test('no client -> config failure', async () => {
    reset();
    mode = 'missing';
    const res = await lifecycle.recordProductionOutput(ORDER, 5);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe('config');
    expect(calls).toHaveLength(0);
  });

  test('ok maps the FG batch and sends unit_cost null (no cost invented client-side)', async () => {
    reset();
    reply = { data: { out_status: 'ok', out_batch_id: 'fg-1' }, error: null };
    const res = await lifecycle.recordProductionOutput(ORDER, 5, 1, 0, 'wh-fg');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.batchId).toBe('fg-1');
    expect(calls[0].name).toBe('record_production_output');
    expect(calls[0].params.p_unit_cost).toBeNull();
    expect(calls[0].params.p_good_quantity).toBe(5);
    expect(calls[0].params.p_defective_quantity).toBe(1);
    expect(calls[0].params.p_destination_warehouse_id).toBe('wh-fg');
  });

  test('zero quantities are refused by the server and mapped', async () => {
    reset();
    reply = { data: { out_status: 'invalid_quantity' }, error: null };
    const res = await lifecycle.recordProductionOutput(ORDER, 0, 0, 0);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.messageAr).toBe('يجب تحديد كمية منتج حادة أو معيبة أو هالك أكبر من صفر.');
  });
});

describe('closeProductionOrder', () => {
  test('no client -> config failure', async () => {
    reset();
    mode = 'missing';
    const res = await lifecycle.closeProductionOrder(ORDER);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe('config');
  });

  test('completed splits material vs conversion from the server total', async () => {
    reset();
    reply = {
      data: {
        out_status: 'completed',
        out_journal_entry_id: 'je-1',
        out_fg_batch_id: 'fg-1',
        out_material_cost: 120,
        out_total_cost: 150,
      },
      error: null,
    };
    const res = await lifecycle.closeProductionOrder(ORDER);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.status).toBe('completed');
      expect(res.materialCost).toBe(120);
      expect(res.conversionCost).toBe(30);
      expect(res.totalCost).toBe(150);
      expect(res.journalEntryId).toBe('je-1');
      expect(res.fgBatchId).toBe('fg-1');
    }
    expect(calls[0].name).toBe('close_production_order');
    expect(calls[0].params.p_unit_cost).toBeNull();
  });

  test('material-only order: conversion 0, still one journal id returned', async () => {
    reset();
    reply = {
      data: { out_status: 'completed', out_journal_entry_id: 'je-2', out_material_cost: 80, out_total_cost: 80 },
      error: null,
    };
    const res = await lifecycle.closeProductionOrder(ORDER);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.conversionCost).toBe(0);
      expect(res.totalCost).toBe(80);
    }
  });

  test('retry after a successful close is reported as existing, not a second journal', async () => {
    reset();
    reply = {
      data: { out_status: 'existing', out_journal_entry_id: 'je-1', out_material_cost: 120, out_total_cost: 150 },
      error: null,
    };
    const res = await lifecycle.closeProductionOrder(ORDER);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.status).toBe('existing');
      expect(res.journalEntryId).toBe('je-1');
    }
  });

  test('already completed order short-circuits', async () => {
    reset();
    reply = { data: { out_status: 'already_completed', out_journal_entry_id: 'je-9' }, error: null };
    const res = await lifecycle.closeProductionOrder(ORDER);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.status).toBe('already_completed');
  });

  test('accounting blockers are surfaced, never swallowed', async () => {
    reset();
    reply = { data: { out_status: 'closed_period' }, error: null };
    let res = await lifecycle.closeProductionOrder(ORDER);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.messageAr).toBe('الفترة المالية مغلقة — لا يمكن إكمال أمر الإنتاج.');

    reset();
    reply = { data: { out_status: 'cancelled' }, error: null };
    res = await lifecycle.closeProductionOrder(ORDER);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.messageAr).toBe('أمر الإنتاج ملغى ولا يمكن إكماله.');

    reset();
    reply = { data: null, error: { message: 'permission denied for function close_production_order' } };
    res = await lifecycle.closeProductionOrder(ORDER);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe('not_authorized');
  });

  test('a disabled server path is reported as a refusal, never as success', async () => {
    reset();
    reply = { data: { out_status: 'completion_not_available' }, error: null };
    let res = await lifecycle.closeProductionOrder(ORDER);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.messageAr).toBe(
        'إقفال أمر الإنتاج غير متاح بعد على الخادم — لم يُرحَّل أي قيد ولا تغيّر أي مخزون.',
      );
    }

    reset();
    reply = { data: { out_status: 'not_available' }, error: null };
    res = await lifecycle.closeProductionOrder(ORDER);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.messageAr).toBe(
        'دورة إكمال الإنتاج غير متاحة على هذا الخادم بعد — لم يُرحَّل أي قيد ولا تغيّر أي مخزون.',
      );
    }
  });

  test('mapping-missing error text is passed through unchanged', async () => {
    reset();
    reply = {
      data: null,
      error: { message: 'account mapping inventory_finished_local is missing; finished goods cannot be capitalised' },
    };
    const res = await lifecycle.closeProductionOrder(ORDER);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.messageAr).toContain('inventory_finished_local is missing');
  });

  test('no consumption on the order is a refusal, not a zero-cost successful close', async () => {
    reset();
    reply = { data: { out_status: 'no_consumption' }, error: null };
    const res = await lifecycle.closeProductionOrder(ORDER);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.messageAr).toBe('لا يوجد صرف مواد فعلي على هذا الأمر — اصرف المواد أولًا.');
  });
});

describe('idempotent resubmission', () => {
  test('a stable key is sent for consumption, output and close', async () => {
    reset();
    reply = { data: { out_status: 'ok', out_consumed: [] }, error: null };
    await lifecycle.issueProductionConsumption(
      ORDER,
      [{ materialItemId: 'mat-1', quantity: 4, warehouseId: 'wh-raw' }],
      'retry-key-1',
    );
    expect(calls[0].params.p_idempotency_key).toBe('retry-key-1');

    reset();
    reply = { data: { out_status: 'existing', out_consumed: [] }, error: null };
    const again = await lifecycle.issueProductionConsumption(ORDER, [], 'retry-key-1');
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.consumed).toEqual([]);

    reset();
    reply = { data: { out_status: 'existing', out_batch_id: 'fg-1' }, error: null };
    const out = await lifecycle.recordProductionOutput(ORDER, 5, 0, 0, undefined, 'retry-key-2');
    expect(out.ok).toBe(true);
    expect(calls[0].params.p_idempotency_key).toBe('retry-key-2');

    reset();
    reply = { data: { out_status: 'existing', out_journal_entry_id: 'je-1' }, error: null };
    const closed = await lifecycle.closeProductionOrder(ORDER, 'retry-key-3');
    expect(closed.ok).toBe(true);
    expect(calls[0].params.p_idempotency_key).toBe('retry-key-3');
  });
});

describe('listProductionBom + planBomRequirements', () => {
  test('BOM lines map to the typed contract and send the order id', async () => {
    reset();
    reply = {
      data: [
        {
          material_item_id: 'mat-1',
          material_code: 'RM-01',
          material_name_ar: 'بطاطس خام',
          quantity_required: 25,
          waste_percentage: 4,
          unit_id: 'unit-kg',
          base_quantity: 100,
          bom_code: 'BOM-CHIPS-01',
        },
      ],
      error: null,
    };
    const res = await lifecycle.listProductionBom(ORDER);
    expect(res.ok).toBe(true);
    expect(calls[0].name).toBe('list_production_bom');
    expect(calls[0].params.p_order_id).toBe(ORDER);
    if (res.ok) {
      expect(res.data[0].quantityRequired).toBe(25);
      expect(res.data[0].baseQuantity).toBe(100);
      expect(res.data[0].bomCode).toBe('BOM-CHIPS-01');
    }
  });

  test('requirements scale by base quantity and add the waste allowance', () => {
    const lines = [
      {
        materialItemId: 'mat-1',
        materialCode: 'RM-01',
        materialNameAr: 'بطاطس خام',
        quantityRequired: 25,
        wastePercentage: 4,
        unitId: 'unit-kg',
        baseQuantity: 100,
        bomCode: 'BOM-1',
      },
      {
        materialItemId: 'mat-2',
        materialCode: 'PK-01',
        materialNameAr: 'كيس',
        quantityRequired: 100,
        wastePercentage: 1,
        unitId: 'unit-piece',
        baseQuantity: 100,
        bomCode: 'BOM-1',
      },
    ];

    const plan = lifecycle.planBomRequirements(lines, 400);
    // 25 / 100 * 400 = 100 net, +4% waste = 104
    expect(plan[0].netQuantity).toBe(100);
    expect(plan[0].wasteQuantity).toBe(4);
    expect(plan[0].requiredQuantity).toBe(104);
    // 100 / 100 * 400 = 400 net, +1% = 404
    expect(plan[1].netQuantity).toBe(400);
    expect(plan[1].requiredQuantity).toBe(404);
  });

  test('a zero / negative good quantity yields zero requirements, never a negative issue', () => {
    const lines = [
      {
        materialItemId: 'mat-1',
        materialCode: 'RM-01',
        materialNameAr: 'بطاطس خام',
        quantityRequired: 25,
        wastePercentage: 4,
        unitId: 'unit-kg',
        baseQuantity: 100,
        bomCode: 'BOM-1',
      },
    ];
    expect(lifecycle.planBomRequirements(lines, 0)[0].requiredQuantity).toBe(0);
    expect(lifecycle.planBomRequirements(lines, -10)[0].requiredQuantity).toBe(0);
  });

  test('fractional gram requirements stay exact to 4 decimals (unit conversion)', () => {
    const lines = [
      {
        materialItemId: 'mat-3',
        materialCode: 'RM-03',
        materialNameAr: 'ملح',
        quantityRequired: 0.075,
        wastePercentage: 2,
        unitId: 'unit-kg',
        baseQuantity: 1,
        bomCode: 'BOM-1',
      },
    ];
    const plan = lifecycle.planBomRequirements(lines, 1000);
    expect(plan[0].netQuantity).toBe(75);
    expect(plan[0].wasteQuantity).toBe(1.5);
    expect(plan[0].requiredQuantity).toBe(76.5);
  });
});
