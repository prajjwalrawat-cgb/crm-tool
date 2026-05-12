import { Skeleton } from '../_components/skeleton';

export default function Loading() {
  return (
    <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
      <header className="mb-5 flex items-end justify-between gap-3">
        <div className="space-y-1.5">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-3 w-32" />
        </div>
        <Skeleton className="h-7 w-40" />
      </header>
      <Skeleton className="mb-3 h-7 w-full max-w-md" />
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-3 py-2">
          <Skeleton className="h-3 w-20" />
        </div>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="border-b border-slate-100 last:border-b-0">
            <Skeleton.Row cols={5} />
          </div>
        ))}
      </div>
    </main>
  );
}
