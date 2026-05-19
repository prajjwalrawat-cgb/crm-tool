/**
 * Brand tokens — single source of truth for color values used outside
 * Tailwind utility classes (SVG fills, chart palettes, embedded HTML
 * email templates). Tailwind utility classes still live inline in
 * components; this module is for raw hex strings.
 *
 * Why a constants file rather than CSS variables: Recharts + SVG icons
 * + future email templates all need raw hex, and pulling from CSS
 * vars would require either a JS bridge or duplicated declarations.
 * Constants are simpler and refactor cleanly.
 */

export const BRAND_COLORS = {
  // Logo mark — refined Google-style palette into a more enterprise tone.
  // Each shape is one of the four core operational ideas of a CRM:
  //   square    = structured data / records
  //   triangle  = growth / pipeline
  //   circle    = customer cycle / relationships
  //   arrow     = momentum / forward motion
  iconSquare: '#4f46e5', // indigo-600 — matches the app's primary accent
  iconTriangle: '#059669', // emerald-600
  iconCircle: '#f59e0b', // amber-500
  iconArrow: '#e11d48', // rose-600

  // Semantic colors. Reused by charts + status badges.
  primary: '#4f46e5',
  success: '#059669',
  warning: '#f59e0b',
  danger: '#e11d48',
  info: '#0ea5e9',
  muted: '#64748b',
} as const;

/**
 * Ordered chart palette. Charts that show multiple series use this in
 * order — first series is the brand primary, then a complementary mix
 * that holds up at small sizes (tooltips, legends).
 */
export const CHART_PALETTE = [
  '#4f46e5', // indigo-600
  '#059669', // emerald-600
  '#f59e0b', // amber-500
  '#e11d48', // rose-600
  '#0ea5e9', // sky-500
  '#8b5cf6', // violet-500
  '#14b8a6', // teal-500
  '#f97316', // orange-500
] as const;

/**
 * Status-pill tints for outcomes like "sent", "failed", "queued".
 * Centralized so the same outcome reads the same way across every
 * surface (email page, ops dashboard, timeline).
 */
export const STATUS_TINTS = {
  positive: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  warning: 'bg-amber-50 text-amber-800 ring-amber-200',
  negative: 'bg-rose-50 text-rose-700 ring-rose-200',
  info: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  neutral: 'bg-slate-100 text-slate-700 ring-slate-200',
} as const;
