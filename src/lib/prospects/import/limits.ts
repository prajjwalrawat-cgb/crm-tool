/**
 * Quick Dump input limits and the messages shown when one is hit. Pure and
 * client-safe (no `server-only`): the server enforces them and the dump
 * input checks them first in the browser, with the same wording.
 */

export const MAX_DUMP_ROWS = 500;
/** Free-text dumps longer than this are rejected rather than silently cut. */
export const MAX_DUMP_CHARS = 60_000;
export const MAX_SOURCE_TAG = 80;
export const MAX_CSV_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Image MIME types a dump may be (image/jpg is a common alias of image/jpeg). */
export const DUMP_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'] as const;

export const IMPORT_MESSAGES = {
  sourceTag: `Add a source tag (up to ${MAX_SOURCE_TAG} characters).`,
  kind: 'Choose text, CSV or image.',
  emptyText: 'Paste something to read first.',
  textTooLong: `This dump is too long. Keep it under ${MAX_DUMP_CHARS.toLocaleString('en-IN')} characters, or split it into parts.`,
  noFile: 'Choose a file to upload.',
  csvTooLarge: 'This CSV is larger than 4 MB. Split it into smaller files.',
  imageTooLarge: 'This image is larger than 5 MB. Use a smaller photo.',
  imageType: 'Use a PNG, JPEG, WebP or GIF image.',
  notFound: 'Import not found.',
  alreadyDone: 'This import was already confirmed or discarded.',
  noRows: 'Select at least one row to add.',
  tooManyRows: `An import can add at most ${MAX_DUMP_ROWS} rows.`,
  invalidRows: 'Some rows need fixing before they can be added.',
} as const;
