import { UsersRound } from 'lucide-react';

export function EmptyState({ canInvite }: { canInvite: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 px-6 py-16 text-center dark:border-zinc-700 dark:bg-zinc-900/40">
      <UsersRound className="h-10 w-10 text-zinc-400" aria-hidden />
      <h2 className="mt-4 text-base font-semibold">No teammates yet</h2>
      <p className="mt-1 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
        {canInvite
          ? 'Invite your first teammate using the form on the right.'
          : 'Ask an admin to invite teammates to this organization.'}
      </p>
    </div>
  );
}
