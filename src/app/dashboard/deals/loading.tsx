export default function Loading() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-5">
        <div className="h-7 w-32 animate-pulse rounded bg-slate-200" />
        <div className="mt-2 h-4 w-48 animate-pulse rounded bg-slate-200" />
      </header>
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-lg border border-slate-200 bg-slate-50"
            />
          ))}
        </div>
        <div className="h-[28rem] animate-pulse rounded-lg border border-slate-200 bg-slate-50" />
      </div>
    </main>
  );
}
