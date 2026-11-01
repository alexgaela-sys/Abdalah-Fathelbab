import React from 'react';
import type { NavTab } from '../../layout/Sidebar';

export type SettingsTab =
  | 'company'
  | 'warehouses'
  | 'storekeepers'
  | 'invoice'
  | 'products'
  | 'mappings'
  | 'data';

export interface CloudUnavailablePanelProps {
  tab?: NavTab | SettingsTab;
}

export function CloudUnavailablePanel({ tab }: CloudUnavailablePanelProps) {
  return (
    <div aria-live="polite" style={{ color: '#b91c1c' }}>
      الوضع السحابي غير متاح حاليًا.
    </div>
  );
}
