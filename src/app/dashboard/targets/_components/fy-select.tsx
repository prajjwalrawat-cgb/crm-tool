'use client';

import { useRouter } from 'next/navigation';

export function FiscalYearSelect({
  value,
  choices,
}: {
  value: number;
  choices: { value: number; label: string }[];
}) {
  const router = useRouter();
  return (
    <select
      value={value}
      onChange={(e) => router.push(`?fy=${e.target.value}`)}
      className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#FAFAFA]"
    >
      {choices.map((c) => (
        <option key={c.value} value={c.value}>
          {c.label}
        </option>
      ))}
    </select>
  );
}
