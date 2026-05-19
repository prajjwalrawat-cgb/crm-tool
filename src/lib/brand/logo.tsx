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
      {/* Top-left: square */}
      <rect
        x="1"
        y="1"
        width="14"
        height="14"
        rx="2"
        fill={BRAND_COLORS.iconSquare}
      />
      {/* Top-right: triangle pointing up */}
      <path
        d="M24 1 L31 15 L17 15 Z"
        fill={BRAND_COLORS.iconTriangle}
      />
      {/* Bottom-left: circle */}
      <circle cx="8" cy="24" r="7" fill={BRAND_COLORS.iconCircle} />
      {/* Bottom-right: arrow pointing up */}
      <path
        d="M24 31 L24 21 M24 21 L20 25 M24 21 L28 25"
        stroke={BRAND_COLORS.iconArrow}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
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
