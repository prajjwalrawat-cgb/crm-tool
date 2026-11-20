/**
 * Bundled quote fonts (public/fonts/quote/). Static Regular + Bold
 * instances of the google/fonts variable TTFs (Noto Sans, Inter, Roboto;
 * SIL OFL 1.1, licences alongside). All six contain the ₹ glyph (U+20B9).
 */
import { Font } from '@react-pdf/renderer';

import type { QuoteTheme } from '../template-schema';

const FILES: Record<QuoteTheme['fontFamily'], { regular: string; bold: string }> = {
  'noto-sans': { regular: 'NotoSans-Regular.ttf', bold: 'NotoSans-Bold.ttf' },
  inter: { regular: 'Inter-Regular.ttf', bold: 'Inter-Bold.ttf' },
  roboto: { regular: 'Roboto-Regular.ttf', bold: 'Roboto-Bold.ttf' },
};

/** react-pdf family name for a theme font. */
export function quoteFontFamily(f: QuoteTheme['fontFamily']): string {
  return `quote-${f}`;
}

let registered = false;

/**
 * Register the bundled fonts with react-pdf. `browser` loads them from
 * /fonts/quote/…, `server` from <cwd>/public/fonts/quote/…. Idempotent:
 * only the first call registers.
 */
export function registerQuoteFonts(base: 'browser' | 'server'): void {
  if (registered) return;
  registered = true;
  // No `path` import: this module is also bundled for the browser.
  const src = (file: string) => (base === 'browser' ? `/fonts/quote/${file}` : `${process.cwd()}/public/fonts/quote/${file}`);
  for (const [family, files] of Object.entries(FILES) as [QuoteTheme['fontFamily'], { regular: string; bold: string }][]) {
    Font.register({
      family: quoteFontFamily(family),
      // No italic files are bundled: italic text maps to the upright faces
      // (react-pdf throws on an unregistered style).
      fonts: [
        { src: src(files.regular), fontWeight: 400 },
        { src: src(files.bold), fontWeight: 700 },
        { src: src(files.regular), fontWeight: 400, fontStyle: 'italic' },
        { src: src(files.bold), fontWeight: 700, fontStyle: 'italic' },
      ],
    });
  }
  // Never split words with hyphens (react-pdf hyphenates English by default).
  Font.registerHyphenationCallback((word) => [word]);
}
