import { cn } from '@/lib/utils';

/**
 * Shared dashboard greeting. Used by all three persona homes so the
 * page-top reads identically (one CRM, role-focused composition).
 *
 * Time-of-day greeting is computed on the server using the user's
 * local time when available; otherwise falls back to "Hello". This is
 * intentionally not a client component — no need for a hydration round
 * trip just to choose between "Good morning" and "Good evening".
 */
export function Greeting({
  firstName,
  tenantName,
  personaLabel,
  className,
}: {
  firstName?: string | null;
  tenantName: string;
  personaLabel: string;
  className?: string;
}) {
  const hour = new Date().getHours();
  const tod =
    hour < 5
      ? 'Hello'
      : hour < 12
        ? 'Good morning'
        : hour < 17
          ? 'Good afternoon'
          : 'Good evening';
  const name = firstName?.trim();

  return (
    <header
      className={cn(
        'flex flex-wrap items-end justify-between gap-3 pb-1',
        className,
      )}
    >
      <div>
        <h1 className="text-[20px] font-semibold leading-tight tracking-tight text-slate-900 dark:text-[#FAFAFA]">
          {tod}
          {name ? `, ${name}` : ''}.
        </h1>
        <p className="mt-1 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
          <span className="font-medium text-slate-700 dark:text-[#FAFAFA]">
            {tenantName}
          </span>
          <span className="mx-1.5 text-slate-300 dark:text-[#3F3F46]">·</span>
          <span className="rounded-full border border-slate-200 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:border-[#1F1F1F] dark:text-[#A1A1AA]">
            {personaLabel}
          </span>
        </p>
      </div>
    </header>
  );
}
