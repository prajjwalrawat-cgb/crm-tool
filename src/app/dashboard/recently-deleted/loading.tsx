import { Skeleton } from '../_components/skeleton';

export default function Loading() {
  return (
    <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
      <header className="mb-5 space-y-1.5">
        <Skeleton className="h-5 w-44" />
        <Skeleton className="h-3 w-72" />
      </header>
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton.Card key={i} className="h-32" lines={3} />
        ))}
      </div>
    </main>
  );
}
