import { Skeleton } from './_components/skeleton';

/**
 * Dashboard root skeleton. Mirrors the widget grid in `page.tsx` so
 * the page doesn't visibly reshuffle when the real data lands.
 */
export default function Loading() {
  return (
    <main className="mx-auto w-full max-w-[88rem] px-4 py-5 sm:px-5 lg:px-6">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1.5">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-3 w-36" />
        </div>
        <div className="w-full max-w-xs space-y-1.5">
          <Skeleton className="h-2.5 w-full" />
          <Skeleton className="h-3 w-20 self-end" />
        </div>
      </header>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton.Card key={i} className="h-[68px] p-3" lines={1} />
        ))}
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Skeleton.Card className="h-32" lines={3} />
        </div>
        <Skeleton.Card className="h-32" lines={3} />
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Skeleton.Card className="h-40" lines={4} />
        </div>
        <Skeleton.Card className="h-40" lines={3} />
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton.Card key={i} className="h-44" lines={4} />
        ))}
      </div>

      <Skeleton.Card className="mt-3 h-56" lines={5} />
    </main>
  );
}
