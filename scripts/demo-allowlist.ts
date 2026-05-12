/**
 * Single source of truth for "which tenants are allowed to hold demo data."
 *
 * Every script that writes generated/sample/seeded rows must read from this
 * allowlist and refuse to operate against any tenant whose name is not
 * listed here. Real production-like tenants (e.g. CGB Solutions, end-user
 * organizations) must NEVER be on this list.
 *
 * Add a tenant to DEMO_TENANT_NAMES only if it's an explicit fixture for
 * development/testing/demos. The name match is exact (case-sensitive)
 * against `tenants.name`.
 */
export const DEMO_TENANT_NAMES: readonly string[] = ['Test 1'];

export function isDemoTenant(name: string): boolean {
  return DEMO_TENANT_NAMES.includes(name);
}
