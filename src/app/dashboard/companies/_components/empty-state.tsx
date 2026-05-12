import { Building2, SearchX } from 'lucide-react';

export function EmptyState({ searchActive }: { searchActive: boolean }) {
  if (searchActive) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 px-6 py-16 text-center">
        <SearchX className="h-10 w-10 text-slate-400" aria-hidden />
        <h2 className="mt-4 text-base font-semibold">No matches</h2>
        <p className="mt-1 max-w-sm text-sm text-slate-500">
          No companies match your search. Try a different name or clear the
          search.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 px-6 py-16 text-center">
      <Building2 className="h-10 w-10 text-slate-400" aria-hidden />
      <h2 className="mt-4 text-base font-semibold">No companies yet</h2>
      <p className="mt-1 max-w-sm text-sm text-slate-500">
        Add your first company using the form on the right. They&apos;ll show
        up here ordered by most recent.
      </p>
    </div>
  );
}
