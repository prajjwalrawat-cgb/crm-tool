import { BarChart3 } from 'lucide-react';
import { Suspense } from 'react';

import { InsightsTabs } from './_components/ui';

export const metadata = { title: 'Sales reports' };

/**
 * Sales reports (build prompt 3): manager views over the metrics registry.
 * Every number on these pages comes from src/lib/reports/manager/services,
 * scoped by scopeUsers (rep = self, manager = reporting-line subtree,
 * admin = workspace).
 */
export default function InsightsLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-[88rem] px-4 py-5 sm:px-5 lg:px-6">
      <header className="mb-3">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-slate-900">
          <BarChart3 className="h-5 w-5 text-slate-500" aria-hidden />
          Sales reports
        </h1>
      </header>
      <Suspense fallback={<div className="h-8" />}>
        <InsightsTabs />
      </Suspense>
      <div className="mt-4">{children}</div>
    </main>
  );
}
