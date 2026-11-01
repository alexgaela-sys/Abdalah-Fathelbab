// scripts/qa_ui_transfer.ts — TEST only.
//
// Exercises the EXACT module the cloud inventory screen calls
// (src/services/cloudInventoryWrite.ts): readCloudInventoryRole() ->
// loadTransferOptions() -> readCloudStock() -> postCloudTransfer().
//
// The transfer needs a real target warehouse, which is why TEST now has two
// (supabase/164_test_operations_master_data.sql).
//
// Run: bun x tsx scripts/qa_ui_transfer.ts

import {
  signInSupabaseTest,
  signOutSupabaseTest,
  supabaseTestUserEmail,
  supabaseTestUserPassword,
} from '../src/services/supabaseTestClient';
import {
  loadTransferOptions,
  postCloudTransfer,
  readCloudInventoryRole,
  readCloudStock,
} from '../src/services/cloudInventoryWrite';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const record = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ` — ${detail}` : ''}`);
};

const qtyOf = (rows: Array<Record<string, unknown>>, warehouseId: string): number =>
  Number(rows.find(r => String(r.warehouse_id) === warehouseId)?.quantity ?? 0);

const main = async (): Promise<number> => {
  const email = supabaseTestUserEmail();
  const password = supabaseTestUserPassword();
  if (!email || !password) {
    record('config: TEST credentials present', false, 'SUPABASE_TEST_USER_EMAIL/PASSWORD missing');
    return 2;
  }

  const signIn = await signInSupabaseTest(email, password);
  if (!signIn.ok) {
    record('auth: sign in', false, signIn.message);
    return 1;
  }
  record('auth: sign in', true, signIn.email ?? email);

  const role = await readCloudInventoryRole();
  if (!role.ok) {
    record('role: readCloudInventoryRole', false, role.messageAr);
    return 1;
  }
  record('role: readCloudInventoryRole', role.canWriteInventory,
    `role=${role.role} canWriteInventory=${role.canWriteInventory}`);
  if (!role.canWriteInventory) return 1;

  const opts = await loadTransferOptions();
  if (!opts.ok) {
    record('options: loadTransferOptions', false, opts.messageAr);
    return 1;
  }
  const { warehouses, items } = opts.data;
  record('options: two warehouses available', warehouses.length >= 2,
    warehouses.map(w => `${w.code}:${w.id}`).join(', '));
  if (warehouses.length < 2) return 1;

  const item = items.find(i => i.code === 'QA-ITEM-01') ?? items[0];
  const source = 'qa-e2e-wh-01';
  const target = 'qa-e2e-wh-02';

  const before = await readCloudStock(item.id);
  if (!before.ok) {
    record('stock: readCloudStock before', false, before.messageAr);
    return 1;
  }
  const srcBefore = qtyOf(before.data, source);
  const tgtBefore = qtyOf(before.data, target);
  record('stock: source has cover', srcBefore >= 5, `${source}=${srcBefore} ${target}=${tgtBefore}`);

  const transfer = await postCloudTransfer({
    itemId: item.id,
    sourceWarehouseId: source,
    targetWarehouseId: target,
    quantity: 5,
    notes: 'اختبار واجهة التحويل السحابية',
  });
  if (!transfer.ok) {
    record('post: postCloudTransfer', false, `${transfer.kind}: ${transfer.messageAr}`);
    await signOutSupabaseTest();
    return 1;
  }
  record('post: postCloudTransfer', Boolean(transfer.documentNumber), transfer.documentNumber);

  const after = await readCloudStock(item.id);
  if (!after.ok) {
    record('stock: readCloudStock after', false, after.messageAr);
    await signOutSupabaseTest();
    return 1;
  }
  const srcAfter = qtyOf(after.data, source);
  const tgtAfter = qtyOf(after.data, target);
  record('stock: source -5 and target +5', srcAfter === srcBefore - 5 && tgtAfter === tgtBefore + 5,
    `${source} ${srcBefore}->${srcAfter}, ${target} ${tgtBefore}->${tgtAfter}`);

  // The form refuses a same-warehouse transfer before it ever reaches the server.
  const sameWarehouse = await postCloudTransfer({
    itemId: item.id,
    sourceWarehouseId: source,
    targetWarehouseId: source,
    quantity: 1,
  });
  record('guard: same source and target refused locally', !sameWarehouse.ok,
    sameWarehouse.ok ? 'unexpectedly accepted' : sameWarehouse.messageAr);

  // Over-issue is refused by the server (no partial write).
  const tooMuch = await postCloudTransfer({
    itemId: item.id,
    sourceWarehouseId: source,
    targetWarehouseId: target,
    quantity: 999999,
  });
  record('guard: impossible quantity refused by server', !tooMuch.ok,
    tooMuch.ok ? 'unexpectedly posted' : tooMuch.messageAr.slice(0, 120));

  await signOutSupabaseTest();

  const failed = results.filter(r => !r.ok).length;
  console.log(`\nDOCUMENT=${transfer.documentNumber}`);
  console.log(`SUMMARY pass=${results.length - failed} fail=${failed} total=${results.length}`);
  return failed > 0 ? 1 : 0;
};

main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error('FAIL | run:', err);
    process.exit(1);
  });
