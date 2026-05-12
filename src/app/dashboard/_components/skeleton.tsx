import { cn } from '@/lib/utils';

/**
 * Single skeleton primitive used everywhere we render a loading placeholder.
 * Centralizing it stops every loading.tsx from rolling its own
 * `animate-pulse rounded bg-X` block and ensures the pulse rate, color,
 * and corner radius stay consistent across the product.
 *
 * Usage:
 *   <Skeleton className="h-4 w-24" />
 *   <Skeleton.Block className="h-40" />     // taller card-sized block
 *   <Skeleton.Line />                       // single text line, default width
 *   <Skeleton.Pill className="w-16" />      // status-pill shaped
 */
function SkeletonBase({
  className,
}: {
  className?: string;
}) {
  return (
    <div
      className={cn(
        'animate-pulse rounded bg-slate-100',
        className,
      )}
      aria-hidden
    />
  );
}

function SkeletonLine({ className }: { className?: string }) {
  return <SkeletonBase className={cn('h-3 w-full', className)} />;
}

function SkeletonBlock({ className }: { className?: string }) {
  return (
    <SkeletonBase className={cn('h-24 w-full rounded-lg', className)} />
  );
}

function SkeletonPill({ className }: { className?: string }) {
  return (
    <SkeletonBase
      className={cn('h-4 w-12 rounded-full bg-slate-200', className)}
    />
  );
}

function SkeletonCard({
  className,
  lines = 3,
}: {
  className?: string;
  lines?: number;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)]',
        className,
      )}
    >
      <SkeletonBase className="h-3 w-1/3" />
      {Array.from({ length: lines }).map((_, i) => (
        <SkeletonBase
          key={i}
          className={cn(
            'h-3',
            i === lines - 1 ? 'w-1/2' : 'w-full',
          )}
        />
      ))}
    </div>
  );
}

function SkeletonRow({ cols = 4 }: { cols?: number }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      {Array.from({ length: cols }).map((_, i) => (
        <SkeletonBase
          key={i}
          className={cn(
            'h-3',
            i === 0 ? 'w-1/3' : i === cols - 1 ? 'w-12' : 'w-1/5',
          )}
        />
      ))}
    </div>
  );
}

export const Skeleton = Object.assign(SkeletonBase, {
  Line: SkeletonLine,
  Block: SkeletonBlock,
  Pill: SkeletonPill,
  Card: SkeletonCard,
  Row: SkeletonRow,
});
