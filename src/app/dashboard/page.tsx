import { auth, currentUser } from '@clerk/nextjs/server';
import { Building2, UsersRound } from 'lucide-react';
import Link from 'next/link';

import { ensureMembership } from '@/lib/membership';
import { requireTenant } from '@/lib/tenant';

export const metadata = {
  title: 'Dashboard',
};

export default async function DashboardPage() {
  const [{ userId, orgId }, user, tenant, membership] = await Promise.all([
    auth(),
    currentUser(),
    requireTenant(),
    ensureMembership(),
  ]);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome back{user?.firstName ? `, ${user.firstName}` : ''}.
        </h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          You&apos;re signed in to <span className="font-medium">{tenant.name}</span>
          {membership ? ` as ${membership.role}` : ''}.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2">
        <QuickLink
          href="/dashboard/companies"
          icon={<Building2 className="h-5 w-5" aria-hidden />}
          title="Companies"
          description="Browse, search, and add companies in this tenant."
        />
        <QuickLink
          href="/dashboard/contacts"
          icon={<UsersRound className="h-5 w-5" aria-hidden />}
          title="Contacts"
          description="Capture people you talk to and link them to companies."
        />
      </section>

      <section className="mt-10 grid gap-4 text-sm sm:grid-cols-3">
        <DebugCard label="Tenant" value={tenant.name} mono />
        <DebugCard label="User ID" value={userId ?? '?'} mono />
        <DebugCard label="Org ID" value={orgId ?? '?'} mono />
      </section>
    </main>
  );
}

function QuickLink({
  href,
  icon,
  title,
  description,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-start gap-4 rounded-lg border border-zinc-200 bg-white p-5 shadow-sm transition hover:border-zinc-300 hover:shadow dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-700 transition group-hover:bg-zinc-900 group-hover:text-white dark:bg-zinc-800 dark:text-zinc-300 dark:group-hover:bg-zinc-100 dark:group-hover:text-zinc-900">
        {icon}
      </div>
      <div>
        <div className="font-medium">{title}</div>
        <div className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
          {description}
        </div>
      </div>
    </Link>
  );
}

function DebugCard({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="text-xs uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      <div
        className={`mt-1 break-all text-sm ${mono ? 'font-mono' : ''}`}
      >
        {value}
      </div>
    </div>
  );
}
