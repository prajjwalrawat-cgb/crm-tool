'use client';

import { Loader2, ShieldX, Trash2 } from 'lucide-react';
import { useOptimistic, useState, useTransition } from 'react';

import type { MembershipRole, MembershipStatus } from '@/db/schema';
import { canInviteMembers, canManageRoles, canRemoveMembers } from '@/lib/rbac';
import type {
  PendingInvitationRow,
  TeamMemberRow,
} from '@/lib/team/queries';
import { type InviteRole, INVITE_ROLES } from '@/lib/team/schema';
import { cn } from '@/lib/utils';

import {
  changeMemberRoleAction,
  inviteMemberAction,
  removeMemberAction,
  revokeInvitationAction,
} from '../actions';
import { EmptyState } from './empty-state';
import { InviteForm } from './invite-form';

type OptimisticInvite = PendingInvitationRow & { __pending?: boolean };

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

function displayName(m: TeamMemberRow): string {
  const parts = [m.firstName, m.lastName].filter(Boolean) as string[];
  if (parts.length) return parts.join(' ');
  return m.email ?? m.userId;
}

function clerkRoleToInviteRole(role: string): InviteRole | null {
  if (role === 'org:admin') return 'admin';
  if (role === 'org:member') return 'member';
  return null;
}

export function TeamView({
  members,
  pendingInvitations,
  currentRole,
  currentUserId,
}: {
  members: TeamMemberRow[];
  pendingInvitations: PendingInvitationRow[];
  currentRole: MembershipRole;
  currentUserId: string;
}) {
  const canInvite = canInviteMembers(currentRole);
  const canManageRolesUI = canManageRoles(currentRole);
  const canRemove = canRemoveMembers(currentRole);

  /* -------- INVITE state -------- */
  const [optimisticInvites, addOptimisticInvite] = useOptimistic<
    OptimisticInvite[],
    OptimisticInvite
  >(pendingInvitations, (state, draft) => [draft, ...state]);

  const [invitePending, startInviteTransition] = useTransition();
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteFieldErrors, setInviteFieldErrors] = useState<
    Record<string, string[]>
  >({});
  const [inviteResetKey, setInviteResetKey] = useState(0);

  /* -------- shared row-action state -------- */
  const [actionError, setActionError] = useState<string | null>(null);

  function handleInvite(formData: FormData) {
    setInviteError(null);
    setInviteFieldErrors({});

    const email = String(formData.get('email') ?? '').trim();
    const roleRaw = String(formData.get('role') ?? 'member');
    const role = (INVITE_ROLES as readonly string[]).includes(roleRaw)
      ? (roleRaw as InviteRole)
      : 'member';

    const draft: OptimisticInvite = {
      id: `optimistic-${crypto.randomUUID()}`,
      emailAddress: email,
      role: role === 'admin' ? 'org:admin' : 'org:member',
      createdAt: new Date(),
      __pending: true,
    };

    startInviteTransition(async () => {
      addOptimisticInvite(draft);
      const result = await inviteMemberAction(formData);
      if (!result.ok) {
        setInviteError(result.message);
        setInviteFieldErrors(result.fieldErrors ?? {});
      } else {
        setInviteResetKey((k) => k + 1);
      }
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <section className="flex flex-col gap-6">
        {actionError ? (
          <p
            role="alert"
            className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {actionError}
          </p>
        ) : null}

        {members.length === 0 ? (
          <EmptyState canInvite={canInvite} />
        ) : (
          <MembersTable
            members={members}
            currentUserId={currentUserId}
            canManageRoles={canManageRolesUI}
            canRemove={canRemove}
            onActionError={setActionError}
          />
        )}

        <PendingInvitations
          invites={optimisticInvites}
          canRevoke={canInvite}
          onActionError={setActionError}
        />
      </section>

      <aside>
        {canInvite ? (
          <InviteForm
            onSubmit={handleInvite}
            pending={invitePending}
            error={inviteError}
            fieldErrors={inviteFieldErrors}
            resetKey={inviteResetKey}
          />
        ) : (
          <ReadOnlyNotice />
        )}
      </aside>
    </div>
  );
}

/* -------- Members table -------- */

function MembersTable({
  members,
  currentUserId,
  canManageRoles,
  canRemove,
  onActionError,
}: {
  members: TeamMemberRow[];
  currentUserId: string;
  canManageRoles: boolean;
  canRemove: boolean;
  onActionError: (msg: string | null) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-100 text-[13px]">
          <thead className="bg-slate-50/95 text-[10px] uppercase tracking-[0.06em] text-slate-500 backdrop-blur">
            <tr>
              <th scope="col" className="px-4 py-2.5 text-left font-medium">
                Member
              </th>
              <th scope="col" className="px-4 py-2.5 text-left font-medium">
                Role
              </th>
              <th
                scope="col"
                className="hidden px-4 py-2.5 text-left font-medium sm:table-cell"
              >
                Status
              </th>
              <th
                scope="col"
                className="hidden px-4 py-2.5 text-right font-medium sm:table-cell"
              >
                Joined
              </th>
              {(canManageRoles || canRemove) ? (
                <th
                  scope="col"
                  className="px-4 py-2.5 text-right font-medium"
                >
                  <span className="sr-only">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {members.map((m) => (
              <MemberRow
                key={m.id}
                member={m}
                isSelf={m.userId === currentUserId}
                canManageRoles={canManageRoles}
                canRemove={canRemove}
                onActionError={onActionError}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MemberRow({
  member,
  isSelf,
  canManageRoles,
  canRemove,
  onActionError,
}: {
  member: TeamMemberRow;
  isSelf: boolean;
  canManageRoles: boolean;
  canRemove: boolean;
  onActionError: (msg: string | null) => void;
}) {
  const [rolePending, startRoleTransition] = useTransition();
  const [removePending, startRemoveTransition] = useTransition();
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  // Owners are protected from inline role changes — Clerk has no native owner
  // concept, so reassigning would silently downgrade them. Demoting an owner
  // is a deliberate, separate operation we'll add when needed.
  const showRoleSelect =
    canManageRoles &&
    !isSelf &&
    member.role !== 'owner' &&
    (member.role === 'admin' || member.role === 'member');

  const showRemove = canRemove && !isSelf && member.role !== 'owner';
  const showActionsCell = canManageRoles || canRemove;

  function handleRoleChange(nextRole: InviteRole) {
    onActionError(null);
    const formData = new FormData();
    formData.set('userId', member.userId);
    formData.set('role', nextRole);
    startRoleTransition(async () => {
      const result = await changeMemberRoleAction(formData);
      if (!result.ok) onActionError(result.message);
    });
  }

  function handleRemove() {
    onActionError(null);
    startRemoveTransition(async () => {
      const result = await removeMemberAction(member.userId);
      if (!result.ok) {
        onActionError(result.message);
        setConfirmingRemove(false);
      }
    });
  }

  return (
    <tr>
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <Avatar member={member} />
          <div>
            <div className="font-medium">
              {displayName(member)}
              {isSelf ? (
                <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">
                  You
                </span>
              ) : null}
            </div>
            {member.email ? (
              <div className="text-xs text-slate-500">{member.email}</div>
            ) : null}
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        {showRoleSelect ? (
          <select
            defaultValue={member.role}
            disabled={rolePending}
            onChange={(e) => handleRoleChange(e.target.value as InviteRole)}
            aria-label={`Change role for ${displayName(member)}`}
            className={cn(
              'rounded-md border border-slate-200 bg-white px-2 py-1 text-xs shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20',
              rolePending && 'opacity-60',
            )}
          >
            {INVITE_ROLES.map((r) => (
              <option key={r} value={r}>
                {r === 'admin' ? 'Admin' : 'Member'}
              </option>
            ))}
          </select>
        ) : (
          <RoleBadge role={member.role} />
        )}
      </td>
      <td className="hidden px-4 py-3 sm:table-cell">
        <StatusBadge status={member.status} />
      </td>
      <td className="hidden whitespace-nowrap px-4 py-3 text-right text-xs text-slate-500 sm:table-cell">
        {dateFormatter.format(new Date(member.createdAt))}
      </td>
      {showActionsCell ? (
        <td className="whitespace-nowrap px-4 py-3 text-right">
          {showRemove ? (
            confirmingRemove ? (
              <span className="inline-flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleRemove}
                  disabled={removePending}
                  className="inline-flex items-center gap-1 rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-60"
                >
                  {removePending ? (
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  ) : null}
                  Confirm
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingRemove(false)}
                  disabled={removePending}
                  className="rounded-md border border-slate-200 px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-60"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingRemove(true)}
                aria-label={`Remove ${displayName(member)}`}
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-red-50 hover:text-red-700"
              >
                <Trash2 className="h-3 w-3" aria-hidden />
                Remove
              </button>
            )
          ) : null}
        </td>
      ) : null}
    </tr>
  );
}

/* -------- Pending invitations -------- */

function PendingInvitations({
  invites,
  canRevoke,
  onActionError,
}: {
  invites: OptimisticInvite[];
  canRevoke: boolean;
  onActionError: (msg: string | null) => void;
}) {
  if (invites.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold">Pending invitations</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          Sent via Clerk. They&apos;ll appear above once accepted.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-100 text-[13px]">
          <thead className="bg-slate-50/95 text-[10px] uppercase tracking-[0.06em] text-slate-500 backdrop-blur">
            <tr>
              <th scope="col" className="px-4 py-2.5 text-left font-medium">
                Email
              </th>
              <th scope="col" className="px-4 py-2.5 text-left font-medium">
                Role
              </th>
              <th
                scope="col"
                className="hidden px-4 py-2.5 text-right font-medium sm:table-cell"
              >
                Sent
              </th>
              {canRevoke ? (
                <th
                  scope="col"
                  className="px-4 py-2.5 text-right font-medium"
                >
                  <span className="sr-only">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {invites.map((inv) => (
              <PendingInviteRow
                key={inv.id}
                invite={inv}
                canRevoke={canRevoke}
                onActionError={onActionError}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PendingInviteRow({
  invite,
  canRevoke,
  onActionError,
}: {
  invite: OptimisticInvite;
  canRevoke: boolean;
  onActionError: (msg: string | null) => void;
}) {
  const [revokePending, startRevokeTransition] = useTransition();
  const inviteRole = clerkRoleToInviteRole(invite.role);
  const isOptimistic = invite.__pending === true;

  function handleRevoke() {
    onActionError(null);
    startRevokeTransition(async () => {
      const result = await revokeInvitationAction(invite.id);
      if (!result.ok) onActionError(result.message);
    });
  }

  return (
    <tr className={cn(isOptimistic && 'opacity-60')}>
      <td className="px-4 py-3 font-medium">{invite.emailAddress}</td>
      <td className="px-4 py-3">
        <span className="text-xs capitalize text-slate-600">
          {inviteRole ?? invite.role}
        </span>
      </td>
      <td className="hidden whitespace-nowrap px-4 py-3 text-right text-xs text-slate-500 sm:table-cell">
        {dateFormatter.format(new Date(invite.createdAt))}
      </td>
      {canRevoke ? (
        <td className="whitespace-nowrap px-4 py-3 text-right">
          {isOptimistic ? (
            <Loader2 className="ml-auto h-3 w-3 animate-spin text-slate-400" aria-hidden />
          ) : (
            <button
              type="button"
              onClick={handleRevoke}
              disabled={revokePending}
              aria-label={`Revoke invitation to ${invite.emailAddress}`}
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-red-50 hover:text-red-700 disabled:opacity-60"
            >
              {revokePending ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              ) : (
                <ShieldX className="h-3 w-3" aria-hidden />
              )}
              Revoke
            </button>
          )}
        </td>
      ) : null}
    </tr>
  );
}

/* -------- Read-only notice for non-admin viewers -------- */

function ReadOnlyNotice() {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 text-sm text-slate-600 shadow-sm">
      <h2 className="text-base font-semibold text-slate-900">
        Read-only view
      </h2>
      <p className="mt-1 text-xs">
        You can see the team but only owners or admins can invite, change
        roles, or remove members.
      </p>
    </div>
  );
}

/* -------- small bits -------- */

function Avatar({ member }: { member: TeamMemberRow }) {
  const initial = (
    member.firstName?.[0] ??
    member.email?.[0] ??
    member.userId[0] ??
    '?'
  ).toUpperCase();
  if (member.imageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={member.imageUrl}
        alt=""
        className="h-8 w-8 rounded-full object-cover"
      />
    );
  }
  return (
    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-200 text-xs font-medium text-slate-700">
      {initial}
    </span>
  );
}

const ROLE_STYLES: Record<MembershipRole, string> = {
  owner: 'bg-amber-100 text-amber-800',
  admin: 'bg-indigo-100 text-indigo-700',
  member: 'bg-slate-100 text-slate-700',
  viewer: 'bg-slate-100 text-slate-700',
};

function RoleBadge({ role }: { role: MembershipRole }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize',
        ROLE_STYLES[role],
      )}
    >
      {role}
    </span>
  );
}

const STATUS_STYLES: Record<MembershipStatus, string> = {
  active: 'bg-emerald-100 text-emerald-700',
  invited: 'bg-blue-100 text-blue-700',
  suspended: 'bg-red-100 text-red-700',
};

function StatusBadge({ status }: { status: MembershipStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize',
        STATUS_STYLES[status],
      )}
    >
      {status}
    </span>
  );
}
