export default function Loading() {
  return (
    <main className="flex min-h-[calc(100vh-3.5rem)] flex-col px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-6">
        <div className="h-7 w-32 animate-pulse rounded bg-slate-200" />
        <div className="mt-2 h-4 w-72 animate-pulse rounded bg-slate-200" />
      </header>
      <div className="flex gap-4 overflow-x-auto">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="flex h-[28rem] w-72 shrink-0 animate-pulse flex-col rounded-lg border border-slate-200 bg-slate-50"
          />
        ))}
      </div>
    </main>
  );
}
