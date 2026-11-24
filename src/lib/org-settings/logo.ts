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

/** Formats react-pdf can embed as-is; anything else (WebP, …) is converted to PNG. */
const PDF_SAFE = new Set(['image/png', 'image/jpeg', 'image/jpg']);

/**
 * Fetch a logo from storage (server-side, so no browser CORS) and return it
 * as a base64 data URL. Logos uploaded as WebP are re-encoded to PNG, since
 * react-pdf (quotes) only embeds PNG and JPEG. Returns null on any failure
 * so the PDF still renders.
 */
export async function fetchLogoDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    let buf: Buffer = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > 3 * 1024 * 1024) return null;
    let mime = (res.headers.get('content-type') || 'image/png').split(';')[0].trim().toLowerCase();
    if (!mime.startsWith('image/')) return null;
    if (!PDF_SAFE.has(mime)) {
      const sharp = (await import('sharp')).default;
      // A logo prints ~30 mm wide: 800 px is ample and keeps PDFs small.
      buf = await sharp(buf).resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
      mime = 'image/png';
    }
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
