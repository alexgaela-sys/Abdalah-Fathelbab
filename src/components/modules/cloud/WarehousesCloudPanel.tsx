// شاشة read-only للمستودعات داخل شاشة الإعدادات الأصلية.
// يعيد استخدام نفس لوحة القراءة السحابية لبيانات core.* (بدون كتابة).

import React from 'react';
import { CloudMasterReadPanel } from './CloudMasterReadPanel';

export function WarehousesCloudPanel() {
  return <CloudMasterReadPanel entity="warehouses" title="المستودعات" schemaTable="core.warehouses" />;
}
