import { BRAND_COLORS } from './tokens';

/**
 * Brand mark — four geometric shapes in a 2×2 grid. The viewBox is
 * deliberately tight (no padding) so the consumer controls the visual
 * gutter via the surrounding container. All shapes use the refined
 * enterprise palette from `tokens.ts`; no hardcoded hex values here.
 *
 * The grid uses a 32×32 unit system. Each cell is 14 units wide with
 * a 2-unit gutter between rows and columns and 1-unit padding on the
 * outer edge. This gives the mark visual breathing room when scaled
 * down (favicons, small sidebar) without looking sparse.
 *
 * Shapes deliberately sized to ~85% of their cell so the corner shape
 * (top-left square) doesn't visually dominate; circles + triangles
 * carry slightly more interior weight than squares at the same bbox.
 */
export function SaleinxIcon({
  size = 24,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      role="img"
      aria-label="Saleinx logo"
    >
      {/*
        Geometry trace against the reference image:
          - 2x2 grid on a 32-unit canvas
          - 2-unit outer padding so the mark stays visible inside any
            container that crops to its bounding box
          - cells centered around (8,8), (24,8), (8,24), (24,24)

        Soft corners on the triangle + arrow come from
        `stroke-linejoin="round"` plus a same-color stroke. The stroke
        expands the fill outward to round vertices without us having to
        hand-author bezier curves. Stroke width 1.5 was tuned to match
        the reference's friendly-but-still-distinct corner radius.
      */}

      {/* Top-left: rounded square (squircle radius for friendly feel) */}
      <rect
        x="2"
        y="2"
        width="12"
        height="12"
        rx="3"
        fill={BRAND_COLORS.iconSquare}
      />

      {/* Top-right: rounded triangle, vertex up */}
      <path
        d="M24 3 L30 14 L18 14 Z"
        fill={BRAND_COLORS.iconTriangle}
        stroke={BRAND_COLORS.iconTriangle}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />

      {/* Bottom-left: circle (slightly smaller than r=7 so it doesn't dominate) */}
      <circle cx="8" cy="24" r="6.5" fill={BRAND_COLORS.iconCircle} />

      {/*
        Bottom-right: a single filled "chunky arrow" pointing up. One
        closed path traces the outline (stem + arrowhead) so the shape
        reads as a single pointer, not three intersecting lines.

        Path walk, counter-clockwise from the bottom-left of the stem:
          22.5 30  → bottom-left of stem
          22.5 23  → top-left of stem
          19   23  → left base of arrowhead
          24   18  → tip
          29   23  → right base of arrowhead
          25.5 23  → top-right of stem
          25.5 30  → bottom-right of stem
      */}
      <path
        d="M22.5 30 L22.5 23 L19 23 L24 18 L29 23 L25.5 23 L25.5 30 Z"
        fill={BRAND_COLORS.iconArrow}
        stroke={BRAND_COLORS.iconArrow}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Wordmark — "saleinx" lowercase. Uses Geist Sans via the inherited
 * font stack (loaded in `app/layout.tsx`). Letter-spacing is tightened
 * to read as a single unit rather than spaced letters. Color falls
 * through to `currentColor` so the consumer controls the tint via
 * Tailwind text-* utilities.
 */
export function SaleinxWordmark({
  size = 'md',
  className,
}: {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}) {
  const fontSize =
    size === 'sm'
      ? 'text-[16px]'
      : size === 'md'
        ? 'text-[20px]'
        : size === 'lg'
          ? 'text-[28px]'
          : 'text-[36px]';
  return (
    <span
      className={[
        'inline-block font-semibold tracking-[-0.025em] text-slate-900 dark:text-slate-50',
        fontSize,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      saleinx
    </span>
  );
}

/**
 * Composed logo — icon + wordmark with appropriate spacing. The most
 * common consumer (sidebar, auth pages). For tighter layouts use
 * `<SaleinxIcon />` and `<SaleinxWordmark />` directly.
 */
export function SaleinxLogo({
  size = 'md',
  showWordmark = true,
  className,
}: {
  size?: 'sm' | 'md' | 'lg';
  showWordmark?: boolean;
  className?: string;
}) {
  const iconPx = size === 'sm' ? 20 : size === 'md' ? 26 : 36;
  const wordmarkSize: 'sm' | 'md' | 'lg' = size === 'lg' ? 'lg' : size;
  return (
    <span
      className={[
        'inline-flex items-center gap-2',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <SaleinxIcon size={iconPx} />
      {showWordmark ? <SaleinxWordmark size={wordmarkSize} /> : null}
    </span>
  );
}
