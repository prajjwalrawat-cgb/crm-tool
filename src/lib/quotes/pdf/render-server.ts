import 'server-only';

import { renderToBuffer } from '@react-pdf/renderer';

import type { QuoteRenderInput } from './context';
import { registerQuoteFonts } from './fonts';
import { QuoteDocument } from './quote-document';

/** Render the quote PDF on the server (fonts from public/fonts/quote). */
export async function renderQuotePdfServer(input: QuoteRenderInput): Promise<Uint8Array> {
  registerQuoteFonts('server');
  const buf = await renderToBuffer(QuoteDocument(input));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
