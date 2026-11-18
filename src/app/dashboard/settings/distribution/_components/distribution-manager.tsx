'use client';

import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import {
  CONDITION_OPS,
  DISTRIBUTION_STRATEGIES,
  WEEKDAYS,
  type ConditionOp,
  type DistributionStrategy,
  type RuleCondition,
  type Weekday,
} from '@/lib/lead-capture/constants';
import { cn } from '@/lib/utils';

import {
  deleteDistributionRuleAction,
  reorderDistributionRulesAction,
  saveDistributionRuleAction,
  saveRoutingProfileAction,
  simulateDistributionAction,
  type SimulationView,
} from '../../lead-capture/actions';
import { Badge, Button, Card, EmptyState, Field, formatWhen, inputCls, selectCls, Toggle } from '../../lead-capture/_components/ui';

type Pool = { user_ids: string[]; weights?: Record<string, number>; fixed_owner_id?: string };
type WorkingHours = { tz: string; days: Partial<Record<Weekday, [string, string]>> };

export type RuleView = {
  id: string;
  name: string;
  priority: number;
  conditions: RuleCondition[];
  strategy: DistributionStrategy;
  pool: Pool;
  capacityCap: number | null;
  respectAvailability: boolean;
  slaMinutes: number;
  maxReassignments: number;
  isDefault: boolean;
  isActive: boolean;
};
type Person = { id: string; name: string; role: string | null };
type Profile = { userId: string; isAvailable: boolean; workingHours: WorkingHours | null; skills: string[]; regions: string[] };

const STRATEGY_LABEL: Record<DistributionStrategy, string> = {
  round_robin: 'Round robin',
  weighted: 'Weighted round robin',
  least_loaded: 'Least loaded',
  skill_match: 'Skill / product match',
  geo_match: 'Region match',
  fixed_owner: 'Fixed owner',
};
const OP_LABEL: Record<ConditionOp, string> = {
  eq: 'is',
  neq: 'is not',
  in: 'is one of',
  contains: 'contains',
  gt: 'greater than',
  lt: 'less than',
  exists: 'is filled',
};
const FIELDS: Array<{ key: string; label: string }> = [
  { key: 'source_id', label: 'Lead source' },
  { key: 'source_type', label: 'Source type' },
  { key: 'state', label: 'State' },
  { key: 'city', label: 'City' },
  { key: 'product_interest', label: 'Product interest' },
  { key: 'company', label: 'Company' },
  { key: 'email_domain', label: 'Email domain' },
  { key: 'utm_source', label: 'UTM source' },
  { key: 'utm_medium', label: 'UTM medium' },
  { key: 'utm_campaign', label: 'UTM campaign' },
  { key: 'amount', label: 'Deal amount' },
];
const BLOCKED_LABEL: Record<string, string> = {
  not_member: 'not an active member',
  excluded: 'already had this lead',
  unavailable: 'marked unavailable',
  off_hours: 'off shift',
  at_capacity: 'at capacity',
};

const emptyRule = (): Omit<RuleView, 'id' | 'priority'> => ({
  name: '',
  conditions: [],
  strategy: 'round_robin',
  pool: { user_ids: [] },
  capacityCap: null,
  respectAvailability: true,
  slaMinutes: 30,
  maxReassignments: 2,
  isDefault: false,
  isActive: true,
});

export function DistributionManager({
  rules,
  sources,
  people,
  profiles,
}: {
  rules: RuleView[];
  sources: Array<{ id: string; name: string }>;
  people: Person[];
  profiles: Profile[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [order, setOrder] = useState(rules.map((r) => r.id));
  const [editing, setEditing] = useState<RuleView | 'new' | null>(null);
  const byId = new Map(rules.map((r) => [r.id, r]));
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? id;
  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  // Keep local order in sync when the server list changes.
  const serverKey = rules.map((r) => r.id).join(',');
  const [lastKey, setLastKey] = useState(serverKey);
  if (serverKey !== lastKey) {
    setLastKey(serverKey);
    setOrder(rules.map((r) => r.id));
  }

  function onDragEnd(e: DragEndEvent) {
    if (!e.over || e.active.id === e.over.id) return;
    const next = arrayMove(order, order.indexOf(String(e.active.id)), order.indexOf(String(e.over.id)));
    setOrder(next);
    startTransition(async () => {
      const r = await reorderDistributionRulesAction(next);
      if (!r.ok) {
        toast.error(r.message);
        setOrder(rules.map((x) => x.id));
        return;
      }
      toast.success('Priority updated');
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <Card
        title="Rules"
        description="Drag to change priority. The workspace default only applies when nothing above it matches."
        actions={
          <Button variant="primary" onClick={() => setEditing('new')}>
            <Plus className="h-3.5 w-3.5" aria-hidden /> New rule
          </Button>
        }
      >
        {rules.length === 0 ? (
          <EmptyState title="No rules yet">Without a rule every captured lead waits in the unassigned queue.</EmptyState>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={order} strategy={verticalListSortingStrategy}>
              <ol className="space-y-1.5">
                {order.map((id, i) => {
                  const r = byId.get(id);
                  if (!r) return null;
                  return (
                    <SortableRule
                      key={id}
                      rule={r}
                      index={i}
                      nameOf={nameOf}
                      sourceName={(sid) => sources.find((s) => s.id === sid)?.name ?? 'unknown source'}
                      onEdit={() => setEditing(r)}
                      onDelete={() => {
                        if (!confirm(`Delete rule “${r.name}”?`)) return;
                        startTransition(async () => {
                          const res = await deleteDistributionRuleAction(r.id);
                          if (!res.ok) return void toast.error(res.message);
                          toast.success('Rule deleted');
                          router.refresh();
                        });
                      }}
                      disabled={pending}
                    />
                  );
                })}
              </ol>
            </SortableContext>
          </DndContext>
        )}
      </Card>

      {editing ? (
        <RuleEditor
          key={editing === 'new' ? 'new' : editing.id}
          initial={editing === 'new' ? null : editing}
          people={people}
          sources={sources}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      ) : null}

      <SimulatePanel sources={sources} nameOf={nameOf} />
      <RoutingProfiles people={people} profiles={profiles} />
    </div>
  );
}

function describeConditions(conds: RuleCondition[], sourceName: (id: string) => string): string {
  if (conds.length === 0) return 'every lead';
  return conds
    .map((c) => {
      const f = FIELDS.find((x) => x.key === c.field)?.label ?? c.field;
      const v = c.field === 'source_id' && typeof c.value === 'string' ? sourceName(c.value) : Array.isArray(c.value) ? c.value.join(', ') : String(c.value ?? '');
      return c.op === 'exists' ? `${f} ${c.value === false ? 'is empty' : 'is filled'}` : `${f} ${OP_LABEL[c.op]} ${v}`;
    })
    .join(' and ');
}

function SortableRule({
  rule,
  index,
  nameOf,
  sourceName,
  onEdit,
  onDelete,
  disabled,
}: {
  rule: RuleView;
  index: number;
  nameOf: (id: string) => string;
  sourceName: (id: string) => string;
  onEdit: () => void;
  onDelete: () => void;
  disabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: rule.id });
  const poolNames =
    rule.strategy === 'fixed_owner' && rule.pool.fixed_owner_id ? nameOf(rule.pool.fixed_owner_id) : rule.pool.user_ids.map(nameOf).join(', ');
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'flex items-start gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2 dark:border-[#262626] dark:bg-[#111111]',
        isDragging && 'z-10 shadow-lg',
        !rule.isActive && 'opacity-60',
      )}
    >
      <button type="button" className="mt-0.5 cursor-grab text-slate-400 hover:text-slate-600" aria-label={`Drag to reorder ${rule.name}`} {...attributes} {...listeners}>
        <GripVertical className="h-4 w-4" aria-hidden />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] tabular-nums text-slate-400">{index + 1}.</span>
          <span className="text-[13px] font-medium text-slate-900 dark:text-[#FAFAFA]">{rule.name}</span>
          <Badge tone="received">{STRATEGY_LABEL[rule.strategy]}</Badge>
          {rule.isDefault ? <Badge tone="duplicate">Workspace default</Badge> : null}
          {!rule.isActive ? <Badge tone="inactive">Off</Badge> : null}
        </div>
        <div className="mt-0.5 text-[12px] text-slate-600 dark:text-[#A1A1AA]">
          When {describeConditions(rule.conditions, sourceName)} → {poolNames || 'nobody yet'} · SLA {rule.slaMinutes} min · up to{' '}
          {rule.maxReassignments} reassignment{rule.maxReassignments === 1 ? '' : 's'}
          {rule.capacityCap ? ` · cap ${rule.capacityCap} untouched` : ''}
          {rule.respectAvailability ? '' : ' · ignores working hours'}
        </div>
      </div>
      <Button variant="ghost" onClick={onEdit} aria-label={`Edit ${rule.name}`} disabled={disabled}>
        <Pencil className="h-3.5 w-3.5" aria-hidden />
      </Button>
      <Button variant="ghost" onClick={onDelete} aria-label={`Delete ${rule.name}`} disabled={disabled}>
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
      </Button>
    </li>
  );
}

function RuleEditor({
  initial,
  people,
  sources,
  onClose,
  onSaved,
}: {
  initial: RuleView | null;
  people: Person[];
  sources: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [r, setR] = useState(initial ?? { ...emptyRule(), id: '', priority: 0 });
  const set = <K extends keyof RuleView>(k: K, v: RuleView[K]) => setR((x) => ({ ...x, [k]: v }));
  const setPool = (p: Partial<Pool>) => setR((x) => ({ ...x, pool: { ...x.pool, ...p } }));

  function togglePerson(id: string) {
    const ids = r.pool.user_ids.includes(id) ? r.pool.user_ids.filter((u) => u !== id) : [...r.pool.user_ids, id];
    setPool({ user_ids: ids });
  }

  function save() {
    startTransition(async () => {
      const res = await saveDistributionRuleAction(initial?.id ?? null, {
        name: r.name,
        conditions: r.conditions.map((c) => ({
          ...c,
          value: c.op === 'in' && typeof c.value === 'string' ? c.value.split(',').map((v) => v.trim()).filter(Boolean) : c.op === 'gt' || c.op === 'lt' ? Number(c.value) : c.value,
        })),
        strategy: r.strategy,
        pool: {
          user_ids: r.pool.user_ids,
          ...(r.strategy === 'weighted' ? { weights: r.pool.weights ?? {} } : {}),
          ...(r.strategy === 'fixed_owner' && r.pool.fixed_owner_id ? { fixed_owner_id: r.pool.fixed_owner_id } : {}),
        },
        capacityCap: r.capacityCap,
        respectAvailability: r.respectAvailability,
        slaMinutes: r.slaMinutes,
        maxReassignments: r.maxReassignments,
        isDefault: r.isDefault,
        isActive: r.isActive,
      });
      if (!res.ok) return void toast.error(res.message);
      toast.success(initial ? 'Rule saved' : 'Rule created');
      onSaved();
    });
  }

  return (
    <Card
      title={initial ? `Edit “${initial.name}”` : 'New rule'}
      actions={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={pending}>
            Save rule
          </Button>
        </>
      }
    >
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Name" htmlFor="rule-name">
          <input id="rule-name" className={inputCls} value={r.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Maharashtra furnaces" />
        </Field>
        <Field label="Strategy" htmlFor="rule-strategy">
          <select id="rule-strategy" className={selectCls} value={r.strategy} onChange={(e) => set('strategy', e.target.value as DistributionStrategy)}>
            {DISTRIBUTION_STRATEGIES.map((s) => (
              <option key={s} value={s}>
                {STRATEGY_LABEL[s]}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="mt-4">
        <div className="mb-1 text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">Conditions (all must match)</div>
        <div className="space-y-1.5">
          {r.conditions.map((c, i) => (
            <div key={i} className="grid grid-cols-[1fr_9rem_1fr_auto] items-center gap-2">
              <select
                className={selectCls}
                aria-label="Field"
                value={c.field}
                onChange={(e) => set('conditions', r.conditions.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))}
              >
                {FIELDS.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>
              <select
                className={selectCls}
                aria-label="Operator"
                value={c.op}
                onChange={(e) => set('conditions', r.conditions.map((x, j) => (j === i ? { ...x, op: e.target.value as ConditionOp } : x)))}
              >
                {CONDITION_OPS.map((o) => (
                  <option key={o} value={o}>
                    {OP_LABEL[o]}
                  </option>
                ))}
              </select>
              {c.op === 'exists' ? (
                <span className="text-[12px] text-slate-500">—</span>
              ) : c.field === 'source_id' ? (
                <select
                  className={selectCls}
                  aria-label="Value"
                  value={String(c.value ?? '')}
                  onChange={(e) => set('conditions', r.conditions.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                >
                  <option value="">Pick a source…</option>
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className={inputCls}
                  aria-label="Value"
                  placeholder={c.op === 'in' ? 'comma, separated, values' : 'value'}
                  value={Array.isArray(c.value) ? c.value.join(', ') : String(c.value ?? '')}
                  onChange={(e) => set('conditions', r.conditions.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                />
              )}
              <Button variant="ghost" aria-label="Remove condition" onClick={() => set('conditions', r.conditions.filter((_, j) => j !== i))}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </div>
          ))}
          <Button onClick={() => set('conditions', [...r.conditions, { field: 'state', op: 'eq', value: '' }])}>
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add condition
          </Button>
        </div>
      </div>

      <div className="mt-4">
        <div className="mb-1 text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">
          {r.strategy === 'fixed_owner' ? 'Owner' : 'Pool (rotation order is the order shown)'}
        </div>
        {r.strategy === 'fixed_owner' ? (
          <select className={selectCls} aria-label="Fixed owner" value={r.pool.fixed_owner_id ?? ''} onChange={(e) => setPool({ fixed_owner_id: e.target.value || undefined })}>
            <option value="">Pick a person…</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        ) : (
          <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
            {people.map((p) => {
              const on = r.pool.user_ids.includes(p.id);
              return (
                <label key={p.id} className="flex items-center gap-2 rounded-md border border-slate-200 px-2 py-1.5 text-[12.5px] dark:border-[#262626]">
                  <input type="checkbox" checked={on} onChange={() => togglePerson(p.id)} />
                  <span className="flex-1 truncate">{p.name}</span>
                  {r.strategy === 'weighted' && on ? (
                    <input
                      type="number"
                      min={0}
                      max={100}
                      aria-label={`Weight for ${p.name}`}
                      className={cn(inputCls, 'w-16 px-2 py-1')}
                      value={r.pool.weights?.[p.id] ?? 1}
                      onChange={(e) => setPool({ weights: { ...(r.pool.weights ?? {}), [p.id]: Math.max(0, Math.min(100, Number(e.target.value) || 0)) } })}
                    />
                  ) : null}
                </label>
              );
            })}
          </div>
        )}
        {r.strategy === 'skill_match' || r.strategy === 'geo_match' ? (
          <p className="mt-1 text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
            Matches the lead&apos;s {r.strategy === 'skill_match' ? 'product interest against each person’s skills' : 'city/state against each person’s regions'} (set below in
            Routing profiles); ties go to whoever has fewer open leads.
          </p>
        ) : null}
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-4">
        <Field label="First-response SLA (minutes)" htmlFor="rule-sla">
          <input id="rule-sla" type="number" min={1} className={inputCls} value={r.slaMinutes} onChange={(e) => set('slaMinutes', Math.max(1, Number(e.target.value) || 1))} />
        </Field>
        <Field label="Max reassignments" htmlFor="rule-max">
          <input id="rule-max" type="number" min={0} max={10} className={inputCls} value={r.maxReassignments} onChange={(e) => set('maxReassignments', Math.max(0, Math.min(10, Number(e.target.value) || 0)))} />
        </Field>
        <Field label="Capacity cap" hint="Max untouched leads per person. Empty = no cap." htmlFor="rule-cap">
          <input id="rule-cap" type="number" min={1} className={inputCls} value={r.capacityCap ?? ''} onChange={(e) => set('capacityCap', e.target.value ? Math.max(1, Number(e.target.value)) : null)} />
        </Field>
        <div className="space-y-2 pt-5 text-[12.5px]">
          <label className="flex items-center gap-2">
            <Toggle label="Respect availability and working hours" checked={r.respectAvailability} onChange={(v) => set('respectAvailability', v)} />
            Respect working hours
          </label>
          <label className="flex items-center gap-2">
            <Toggle label="Workspace default rule" checked={r.isDefault} onChange={(v) => set('isDefault', v)} />
            Workspace default
          </label>
          <label className="flex items-center gap-2">
            <Toggle label="Rule active" checked={r.isActive} onChange={(v) => set('isActive', v)} />
            Active
          </label>
        </div>
      </div>
    </Card>
  );
}

function SimulatePanel({ sources, nameOf }: { sources: Array<{ id: string; name: string }>; nameOf: (id: string) => string }) {
  const [pending, startTransition] = useTransition();
  const [sample, setSample] = useState({ sourceId: '', state: '', city: '', productInterest: '', company: '', utmSource: '' });
  const [result, setResult] = useState<SimulationView | null>(null);
  const set = (k: keyof typeof sample, v: string) => setSample((s) => ({ ...s, [k]: v }));

  function run() {
    startTransition(async () => {
      const r = await simulateDistributionAction({
        sourceId: sample.sourceId || null,
        state: sample.state || null,
        city: sample.city || null,
        productInterest: sample.productInterest || null,
        company: sample.company || null,
        utmSource: sample.utmSource || null,
      });
      if (!r.ok) return void toast.error(r.message);
      setResult(r.data ?? null);
    });
  }

  return (
    <Card title="Simulate" description="Describe a lead and see which rule matches and who would get it right now. Nothing is written.">
      <div className="grid gap-2 md:grid-cols-3">
        <Field label="Source" htmlFor="sim-source">
          <select id="sim-source" className={selectCls} value={sample.sourceId} onChange={(e) => set('sourceId', e.target.value)}>
            <option value="">Any / none</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="State" htmlFor="sim-state">
          <input id="sim-state" className={inputCls} value={sample.state} onChange={(e) => set('state', e.target.value)} placeholder="Maharashtra" />
        </Field>
        <Field label="City" htmlFor="sim-city">
          <input id="sim-city" className={inputCls} value={sample.city} onChange={(e) => set('city', e.target.value)} placeholder="Pune" />
        </Field>
        <Field label="Product interest" htmlFor="sim-product">
          <input id="sim-product" className={inputCls} value={sample.productInterest} onChange={(e) => set('productInterest', e.target.value)} />
        </Field>
        <Field label="Company" htmlFor="sim-company">
          <input id="sim-company" className={inputCls} value={sample.company} onChange={(e) => set('company', e.target.value)} />
        </Field>
        <Field label="UTM source" htmlFor="sim-utm">
          <input id="sim-utm" className={inputCls} value={sample.utmSource} onChange={(e) => set('utmSource', e.target.value)} />
        </Field>
      </div>
      <div className="mt-3">
        <Button variant="primary" onClick={run} disabled={pending}>
          <Play className="h-3.5 w-3.5" aria-hidden /> Simulate
        </Button>
      </div>
      {result ? (
        <div className="mt-3 rounded-lg border border-slate-200 p-3 text-[12.5px] dark:border-[#262626]" role="status">
          <div className="font-medium text-slate-900 dark:text-[#FAFAFA]">
            {result.kind === 'assign'
              ? `→ ${nameOf(result.userId!)}`
              : result.kind === 'queued'
                ? `Queued until ${formatWhen(result.retryAt)} (everyone eligible is off shift)`
                : 'Unassigned queue'}
          </div>
          <div className="mt-0.5 text-slate-600 dark:text-[#A1A1AA]">
            Rule: {result.ruleName ?? 'none matched'} · {result.reason}
          </div>
          {result.eligibility.length ? (
            <ul className="mt-2 space-y-0.5">
              {result.eligibility.map((e) => (
                <li key={e.userId} className="flex items-center gap-2">
                  <Badge tone={e.eligible ? 'active' : 'inactive'}>{e.eligible ? 'eligible' : BLOCKED_LABEL[e.blockedBy ?? ''] ?? e.blockedBy}</Badge>
                  <span>{nameOf(e.userId)}</span>
                  <span className="text-slate-500">
                    {e.load} open in 7d · {e.untouchedOpen} untouched
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

const PRESETS: Record<string, WorkingHours | null> = {
  always: null,
  weekdays: { tz: 'Asia/Kolkata', days: { mon: ['09:30', '18:30'], tue: ['09:30', '18:30'], wed: ['09:30', '18:30'], thu: ['09:30', '18:30'], fri: ['09:30', '18:30'] } },
  six_day: {
    tz: 'Asia/Kolkata',
    days: { mon: ['09:30', '18:30'], tue: ['09:30', '18:30'], wed: ['09:30', '18:30'], thu: ['09:30', '18:30'], fri: ['09:30', '18:30'], sat: ['10:00', '14:00'] },
  },
};

function RoutingProfiles({ people, profiles }: { people: Person[]; profiles: Profile[] }) {
  const byUser = new Map(profiles.map((p) => [p.userId, p]));
  return (
    <Card title="Routing profiles" description="Availability, working hours, skills (product lines / languages) and regions used by the rules above. No profile = available all the time.">
      {people.length === 0 ? (
        <EmptyState title="No team members" />
      ) : (
        <div className="divide-y divide-slate-100 dark:divide-[#1F1F1F]">
          {people.map((p) => (
            <ProfileRow key={p.id} person={p} profile={byUser.get(p.id) ?? null} />
          ))}
        </div>
      )}
    </Card>
  );
}

function ProfileRow({ person, profile }: { person: Person; profile: Profile | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [available, setAvailable] = useState(profile?.isAvailable ?? true);
  const [wh, setWh] = useState<WorkingHours | null>(profile?.workingHours ?? null);
  const [skills, setSkills] = useState((profile?.skills ?? []).join(', '));
  const [regions, setRegions] = useState((profile?.regions ?? []).join(', '));
  const [open, setOpen] = useState(false);

  function save(next?: { isAvailable?: boolean }) {
    startTransition(async () => {
      const r = await saveRoutingProfileAction({
        userId: person.id,
        isAvailable: next?.isAvailable ?? available,
        workingHours: wh,
        skills: skills.split(',').map((s) => s.trim()).filter(Boolean),
        regions: regions.split(',').map((s) => s.trim()).filter(Boolean),
      });
      if (!r.ok) return void toast.error(r.message);
      toast.success(`Saved ${person.name}`);
      router.refresh();
    });
  }

  const summary = wh
    ? WEEKDAYS.filter((d) => wh.days[d]).map((d) => `${d} ${wh.days[d]![0]}–${wh.days[d]![1]}`).join(', ') || 'no working days'
    : 'always on';

  return (
    <div className="py-2.5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-[10rem] flex-1">
          <div className="text-[13px] font-medium text-slate-900 dark:text-[#FAFAFA]">{person.name}</div>
          <div className="text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
            {summary}
            {skills ? ` · skills: ${skills}` : ''}
            {regions ? ` · regions: ${regions}` : ''}
          </div>
        </div>
        <label className="flex items-center gap-2 text-[12px]">
          <Toggle
            label={`${person.name} available`}
            checked={available}
            disabled={pending}
            onChange={(v) => {
              setAvailable(v);
              save({ isAvailable: v });
            }}
          />
          {available ? 'Available' : 'Unavailable'}
        </label>
        <Button onClick={() => setOpen((v) => !v)}>{open ? 'Close' : 'Edit'}</Button>
      </div>
      {open ? (
        <div className="mt-2 grid gap-3 rounded-lg bg-slate-50 p-3 md:grid-cols-2 dark:bg-[#0A0A0A]">
          <Field label="Working hours">
            <div className="space-y-1.5">
              <select
                className={selectCls}
                aria-label="Working hours preset"
                value={wh === null ? 'always' : 'custom'}
                onChange={(e) => setWh(e.target.value === 'custom' ? (wh ?? PRESETS.weekdays!) : (PRESETS[e.target.value] ?? null))}
              >
                <option value="always">Always on</option>
                <option value="custom">Custom schedule</option>
              </select>
              {wh ? (
                <>
                  <div className="flex gap-1">
                    <Button onClick={() => setWh(PRESETS.weekdays!)}>Mon–Fri 9:30–18:30</Button>
                    <Button onClick={() => setWh(PRESETS.six_day!)}>+ Sat 10–14</Button>
                  </div>
                  <input className={inputCls} aria-label="Timezone" value={wh.tz} onChange={(e) => setWh({ ...wh, tz: e.target.value })} />
                  {WEEKDAYS.map((d) => {
                    const w = wh.days[d];
                    return (
                      <div key={d} className="flex items-center gap-2 text-[12px]">
                        <label className="flex w-14 items-center gap-1 capitalize">
                          <input
                            type="checkbox"
                            checked={!!w}
                            onChange={(e) => {
                              const days = { ...wh.days };
                              if (e.target.checked) days[d] = ['09:30', '18:30'];
                              else delete days[d];
                              setWh({ ...wh, days });
                            }}
                          />
                          {d}
                        </label>
                        {w ? (
                          <>
                            <input type="time" aria-label={`${d} start`} className={cn(inputCls, 'w-28 py-1')} value={w[0]} onChange={(e) => setWh({ ...wh, days: { ...wh.days, [d]: [e.target.value, w[1]] } })} />
                            <span aria-hidden>–</span>
                            <input type="time" aria-label={`${d} end`} className={cn(inputCls, 'w-28 py-1')} value={w[1]} onChange={(e) => setWh({ ...wh, days: { ...wh.days, [d]: [w[0], e.target.value] } })} />
                          </>
                        ) : (
                          <span className="text-slate-400">off</span>
                        )}
                      </div>
                    );
                  })}
                </>
              ) : null}
            </div>
          </Field>
          <div className="space-y-3">
            <Field label="Skills" hint="Comma-separated product lines or languages, e.g. furnace, crane, Marathi" htmlFor={`skills-${person.id}`}>
              <input id={`skills-${person.id}`} className={inputCls} value={skills} onChange={(e) => setSkills(e.target.value)} />
            </Field>
            <Field label="Regions" hint="Comma-separated states or cities, e.g. Maharashtra, Gujarat, Pune" htmlFor={`regions-${person.id}`}>
              <input id={`regions-${person.id}`} className={inputCls} value={regions} onChange={(e) => setRegions(e.target.value)} />
            </Field>
            <Button variant="primary" onClick={() => save()} disabled={pending}>
              Save profile
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
