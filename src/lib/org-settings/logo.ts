import 'server-only';

import { getOrgSettings } from './queries';

/**
 * The workspace logo, uploaded under Settings → Organization and printed on
 * invoices and quotes. Workspaces that uploaded one under Invoice settings
 * before the logo moved keep it: that older invoice logo is the fallback.
 */
export function workspaceLogoUrl(s: { logoUrl: string | null; invoiceLogoUrl: string | null }): string | null {
  return s.logoUrl ?? s.invoiceLogoUrl ?? null;
}

/**
 * Fetch a logo from storage (server-side, so no browser CORS) and return it
 * as a base64 data URL. Returns null on any failure so the PDF still renders.
 */
export async function fetchLogoDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > 3 * 1024 * 1024) return null;
    const mime = res.headers.get('content-type') || 'image/png';
    if (!mime.startsWith('image/')) return null;
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

/** The workspace logo as a data URL (embeddable in PDFs anywhere), or null. */
export async function workspaceLogoDataUrl(tenantId: string): Promise<string | null> {
  const url = workspaceLogoUrl(await getOrgSettings(tenantId));
  return url ? fetchLogoDataUrl(url) : null;
}
