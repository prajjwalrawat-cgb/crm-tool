import { formatNumber } from '@/lib/dates/format';
import type { ProspectBoardReport } from '@/lib/reports/queries/prospect-board';

const STAGE_LABELS: Record<string, string> = {
  dump: 'Dump',
  researching: 'Researching',
  qualified: 'Qualified',
  ready: 'Ready',
  parked: 'Parked',
};

const EMPTY = 'No prospects in this period.';

/** 0-1 fraction to "NN.N%"; null (empty cohort) to a dash. */
const pct = (rate: number | null) => (rate === null ? '—' : `${(rate * 100).toFixed(1)}%`);

type ConversionRow = { key: string; label: string; cohort: number; promoted: number; rate: number | null };

/**
 * Prospect board report: four compact table blocks (added, conversion, days in
 * stage, stale). Plain server-renderable markup; formatting only, no maths
 * beyond display rounding.
 */
export function ProspectBoardSection({ report }: { report: ProspectBoardReport }) {
  const hasAny =
    report.addedByRep.length > 0 ||
    report.addedBySource.length > 0 ||
    report.conversionBySource.length > 0 ||
    report.conversionByTag.length > 0 ||
    report.conversionByRep.length > 0;

  return (
    <div className="space-y-6">
      <Block title="Added">
        {hasAny ? (
          <div className="grid gap-4 md:grid-cols-2">
            <SimpleTable
              heading="By rep"
              firstCol="Rep"
              rows={report.addedByRep.map((r) => ({ key: r.userId || 'none', label: r.name, count: r.count }))}
            />
            <SimpleTable
              heading="By source"
              firstCol="Source"
              rows={report.addedBySource.map((r) => ({ key: r.sourceTag, label: r.sourceTag, count: r.count }))}
            />
          </div>
        ) : (
          <Empty />
        )}
      </Block>

      <Block title="Conversion">
        {hasAny ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <ConversionTable
              heading="By source"
              rows={report.conversionBySource.map((r) => ({ ...r, label: r.key }))}
            />
            {/* No "By tag" table: prospects no longer have tags. */}
            <ConversionTable
              heading="By rep"
              rows={report.conversionByRep.map((r) => ({ ...r, key: r.userId || 'none', label: r.name }))}
            />
          </div>
        ) : (
          <Empty />
        )}
      </Block>

      <Block title="Days in stage">
        {report.daysInStage.every((d) => d.intervals === 0) ? (
          <Empty />
        ) : (
          <Card>
            <table className="min-w-full divide-y divide-slate-100 text-[13px]">
              <Head cols={[['Stage', 'left'], ['Avg days', 'right'], ['Intervals', 'right']]} />
              <tbody className="divide-y divide-slate-100">
                {report.daysInStage.map((d) => (
                  <tr key={d.stage} className="transition-colors hover:bg-slate-50/70">
                    <td className="px-3 py-2 font-medium">{STAGE_LABELS[d.stage] ?? d.stage}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {d.avgDays === null ? '—' : d.avgDays.toFixed(1)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{formatNumber(d.intervals)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </Block>

      <Block title="Stale">
        <div className="space-y-1 rounded-lg border border-slate-200 bg-white px-4 py-3 text-[13px] text-slate-700 shadow-sm">
          <p>
            <span className="font-mono font-semibold tabular-nums">{formatNumber(report.stale.count)}</span>{' '}
            prospects idle more than {report.stale.thresholdDays} days
          </p>
          <p>
            <span className="font-mono font-semibold tabular-nums">
              {formatNumber(report.stale.autoParkedInRange)}
            </span>{' '}
            auto-parked in this period
          </p>
        </div>
      </Block>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
      {children}
    </section>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">{children}</div>;
}

function Empty() {
  return (
    <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-6 py-6 text-center text-[13px] text-slate-500">
      {EMPTY}
    </div>
  );
}

function Head({ cols }: { cols: [string, 'left' | 'right'][] }) {
  return (
    <thead className="bg-slate-50/95 text-[10px] uppercase tracking-[0.06em] text-slate-500">
      <tr>
        {cols.map(([label, align]) => (
          <th key={label} scope="col" className={`px-3 py-2 font-medium ${align === 'left' ? 'text-left' : 'text-right'}`}>
            {label}
          </th>
        ))}
      </tr>
    </thead>
  );
}

function SimpleTable({
  heading,
  firstCol,
  rows,
}: {
  heading: string;
  firstCol: string;
  rows: { key: string; label: string; count: number }[];
}) {
  return (
    <div>
      <h3 className="mb-1 text-[12px] font-medium text-slate-600">{heading}</h3>
      <Card>
        {rows.length === 0 ? (
          <p className="px-3 py-4 text-center text-[13px] text-slate-500">{EMPTY}</p>
        ) : (
          <table className="min-w-full divide-y divide-slate-100 text-[13px]">
            <Head cols={[[firstCol, 'left'], ['Added', 'right']]} />
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.key} className="transition-colors hover:bg-slate-50/70">
                  <td className="px-3 py-2 font-medium">{r.label}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{formatNumber(r.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function ConversionTable({ heading, rows }: { heading: string; rows: ConversionRow[] }) {
  return (
    <div>
      <h3 className="mb-1 text-[12px] font-medium text-slate-600">{heading}</h3>
      <Card>
        {rows.length === 0 ? (
          <p className="px-3 py-4 text-center text-[13px] text-slate-500">{EMPTY}</p>
        ) : (
          <table className="min-w-full divide-y divide-slate-100 text-[13px]">
            <Head cols={[['Cohort', 'left'], ['Promoted', 'right'], ['Rate', 'right']]} />
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.key} className="transition-colors hover:bg-slate-50/70">
                  <td className="px-3 py-2 font-medium">
                    {r.label}{' '}
                    <span className="font-mono text-[11px] font-normal tabular-nums text-slate-400">
                      {formatNumber(r.cohort)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{formatNumber(r.promoted)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{pct(r.rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
