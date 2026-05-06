import { UserButton } from '@clerk/nextjs';
import { auth, currentUser } from '@clerk/nextjs/server';

export const metadata = {
  title: 'Dashboard',
};

export default async function DashboardPage() {
  // Middleware already gated this route, but pull identity for the UI.
  const { userId } = await auth();
  const user = await currentUser();

  return (
    <main className="flex min-h-screen flex-col px-6 py-8">
      <header className="flex items-center justify-between border-b border-zinc-200 pb-6 dark:border-zinc-800">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Welcome back{user?.firstName ? `, ${user.firstName}` : ''}.
          </p>
        </div>
        <UserButton />
      </header>

      <section className="mt-8 grid gap-4 text-sm">
        <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <div className="text-xs uppercase tracking-wide text-zinc-500">User ID</div>
          <div className="mt-1 font-mono">{userId}</div>
        </div>
      </section>
    </main>
  );
}
