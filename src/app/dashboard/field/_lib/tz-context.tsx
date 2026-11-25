'use client';

import { createContext, useContext, type ReactNode } from 'react';

import { DEFAULT_TZ } from './datetime';

/**
 * Tenant timezone for field components (organization_settings.timezone).
 * Pages wrap their client tree in <TenantTzProvider tz={dayView.tz}>; times are
 * shown and entered in this zone, not the browser's.
 */
const TenantTzContext = createContext<string>(DEFAULT_TZ);

export function TenantTzProvider({ tz, children }: { tz: string; children: ReactNode }) {
  return <TenantTzContext.Provider value={tz}>{children}</TenantTzContext.Provider>;
}

export const useTenantTz = (): string => useContext(TenantTzContext);
