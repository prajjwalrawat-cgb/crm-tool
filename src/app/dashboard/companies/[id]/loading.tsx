import { Skeleton } from '../../_components/skeleton';

/**
 * Account 360 loading state. Mirrors the three-column grid the page
 * settles into — same breakpoints, same column widths, same card
 * shapes — so the layout does not jump when the data lands.
 */
export default function Loading() {
  return (
    <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
      <Skeleton className="h-3 w-24" />

      <header className="mt-3 border-b border-slate-200 pb-5">
        <Skeleton className="h-7 w-64" />
        <Skeleton className="mt-2 h-3 w-80" />
      </header>

      <div className="mt-6 grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)_320px]">
        <aside className="flex flex-col gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton.Card key={i} lines={1} className="p-3" />
          ))}
        </aside>

        <section className="space-y-4">
          <Skeleton.Card lines={3} />
          <Skeleton.Card lines={8} />
          <Skeleton.Card lines={2} />
        </section>

        <aside className="hidden flex-col gap-3 xl:flex">
          <Skeleton.Card lines={5} />
          <Skeleton.Card lines={5} />
        </aside>
      </div>
    </main>
  );
}
