'use client';

import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import type { DealStage } from '@/db/schema';
import {
  GATE_ACTIVITY_TYPES,
  GATE_REQUIRABLE_FIELDS,
  GATE_RULE_META,
  GATE_RULE_TYPES,
  GATE_TASK_TYPES,
  STAGE_LABELS,
  type GateRuleType,
  type GateSeverity,
} from '@/lib/stage-gates/types';
import { cn } from '@/lib/utils';

import {
  deleteStageGateAction,
  setStageGatesEnabledAction,
  toggleStageGateActiveAction,
  upsertStageGateAction,
} from '../actions';

type GateRow = {
  id: string;
  stage: string;
  ruleType: string;
  ruleConfig: Record<string, unknown>;
  severity: string;
  isActive: boolean;
};

// Every stage a deal can enter and be gated on (Lead is the entry stage).
const GATED_STAGES: DealStage[] = [
  'qualified',
  'proposal',
  'negotiation',
  'hold',
  'won',
  'lost',
];

function fieldLabel(key: string): string {
  return GATE_REQUIRABLE_FIELDS.find((f) => f.key === key)?.label ?? key;
}

function summarize(ruleType: string, config: Record<string, unknown>): string {
  switch (ruleType) {
    case 'field_required': {
      const fields = (config.fields as string[]) ?? [];
      return fields.map(fieldLabel).join(', ') || '—';
    }
    case 'min_stakeholders':
      return `≥ ${config.count ?? 1} stakeholder(s)`;
    case 'min_activities': {
      const types = (config.types as string[]) ?? [];
      return `≥ ${config.count ?? 1} of: ${types.join(', ')}`;
    }
    case 'amount_required':
      return `amount ≥ ${config.min ?? 1}`;
    case 'task_complete':
      return `completed "${config.task_type ?? ''}" task`;
    case 'custom_note':
      return `"${config.prompt ?? ''}"`;
    default:
      return '';
  }
}

export function StageGatesManager({
  enabled: initialEnabled,
  gates: initialGates,
}: {
  enabled: boolean;
  gates: GateRow[];
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pending, startTransition] = useTransition();

  function toggleEnabled() {
    const next = !enabled;
    setEnabled(next);
    startTransition(async () => {
      const res = await setStageGatesEnabledAction(next);
      if (!res.ok) {
        setEnabled(!next);
        toast.error(res.message);
      } else {
        toast.success(next ? 'Stage gates enabled' : 'Stage gates disabled');
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-5">
      {/* Feature flag */}
      <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-[#262626] dark:bg-[#0F0F0F]">
        <div>
          <div className="text-[13px] font-medium text-slate-900 dark:text-[#FAFAFA]">
            Enforce stage gates
          </div>
          <div className="text-[12px] text-slate-500 dark:text-[#A1A1AA]">
            When off, gates are ignored everywhere and deals move freely.
          </div>
        </div>
        <button
          type="button"
          onClick={toggleEnabled}
          disabled={pending}
          aria-pressed={enabled}
          className={cn(
            'relative h-6 w-11 shrink-0 rounded-full transition',
            enabled ? 'bg-indigo-600' : 'bg-slate-300 dark:bg-[#333]',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition',
              enabled ? 'left-[22px]' : 'left-0.5',
            )}
          />
        </button>
      </div>

      {/* Per-stage rule tables */}
      <div className={cn('space-y-4', !enabled && 'opacity-60')}>
        {GATED_STAGES.map((stage) => (
          <StageSection
            key={stage}
            stage={stage}
            rules={initialGates.filter((g) => g.stage === stage)}
            onChanged={() => router.refresh()}
          />
        ))}
      </div>
    </div>
  );
}

function StageSection({
  stage,
  rules,
  onChanged,
}: {
  stage: DealStage;
  rules: GateRow[];
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);

  return (
    <section className="rounded-lg border border-slate-200 bg-white dark:border-[#262626] dark:bg-[#0F0F0F]">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5 dark:border-[#1F1F1F]">
        <h2 className="text-[13px] font-semibold text-slate-900 dark:text-[#FAFAFA]">
          {STAGE_LABELS[stage]}
          <span className="ml-2 text-[11px] font-normal text-slate-400">
            {rules.length} rule{rules.length === 1 ? '' : 's'}
          </span>
        </h2>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-500/10"
        >
          <Plus className="h-3.5 w-3.5" /> Add rule
        </button>
      </div>

      {rules.length > 0 ? (
        <ul className="divide-y divide-slate-100 dark:divide-[#1F1F1F]">
          {rules.map((r) => (
            <RuleRow key={r.id} rule={r} onChanged={onChanged} />
          ))}
        </ul>
      ) : (
        <p className="px-4 py-3 text-[12px] text-slate-400">No rules — deals enter this stage freely.</p>
      )}

      {adding ? (
        <AddRuleForm
          stage={stage}
          onDone={() => {
            setAdding(false);
            onChanged();
          }}
        />
      ) : null}
    </section>
  );
}

function RuleRow({ rule, onChanged }: { rule: GateRow; onChanged: () => void }) {
  const [pending, startTransition] = useTransition();

  function toggleActive() {
    startTransition(async () => {
      const res = await toggleStageGateActiveAction({
        id: rule.id,
        isActive: !rule.isActive,
      });
      if (!res.ok) toast.error(res.message);
      else onChanged();
    });
  }

  function remove() {
    startTransition(async () => {
      const res = await deleteStageGateAction(rule.id);
      if (!res.ok) toast.error(res.message);
      else {
        toast.success('Rule removed');
        onChanged();
      }
    });
  }

  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <span
        className={cn(
          'inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
          rule.severity === 'block'
            ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300'
            : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
        )}
      >
        {rule.severity}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-slate-800 dark:text-[#E4E4E7]">
          {GATE_RULE_META[rule.ruleType as GateRuleType]?.label ?? rule.ruleType}
        </div>
        <div className="truncate text-[12px] text-slate-500 dark:text-[#A1A1AA]">
          {summarize(rule.ruleType, rule.ruleConfig)}
        </div>
      </div>
      <button
        type="button"
        onClick={toggleActive}
        disabled={pending}
        className="text-[12px] font-medium text-slate-500 hover:text-slate-900 dark:hover:text-[#FAFAFA]"
      >
        {rule.isActive ? 'On' : 'Off'}
      </button>
      <button
        type="button"
        onClick={remove}
        disabled={pending}
        aria-label="Delete rule"
        className="text-slate-400 hover:text-red-600"
      >
        {pending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Trash2 className="h-4 w-4" />
        )}
      </button>
    </li>
  );
}

const inputCls =
  'rounded-md border border-slate-200 bg-white px-2 py-1 text-[12px] text-slate-900 dark:border-[#333] dark:bg-[#161616] dark:text-[#FAFAFA]';

function AddRuleForm({
  stage,
  onDone,
}: {
  stage: DealStage;
  onDone: () => void;
}) {
  const [ruleType, setRuleType] = useState<GateRuleType>('field_required');
  const [severity, setSeverity] = useState<GateSeverity>('block');
  const [pending, startTransition] = useTransition();

  // Config state (superset; only the relevant fields are read per rule type).
  const [fields, setFields] = useState<string[]>(['contact_id']);
  const [count, setCount] = useState(1);
  const [types, setTypes] = useState<string[]>([...GATE_ACTIVITY_TYPES]);
  const [min, setMin] = useState(1);
  const [taskType, setTaskType] = useState<string>('call');
  const [prompt, setPrompt] = useState('Why are we confident?');

  function buildConfig(): Record<string, unknown> {
    switch (ruleType) {
      case 'field_required':
        return { fields };
      case 'min_stakeholders':
        return { count };
      case 'min_activities':
        return { count, types };
      case 'amount_required':
        return { min };
      case 'task_complete':
        return { task_type: taskType };
      case 'custom_note':
        return { prompt };
      default:
        return {};
    }
  }

  function submit() {
    startTransition(async () => {
      const res = await upsertStageGateAction({
        stage,
        ruleType,
        severity,
        config: buildConfig(),
      });
      if (!res.ok) toast.error(res.message);
      else {
        toast.success('Rule saved');
        onDone();
      }
    });
  }

  function toggleIn(list: string[], value: string): string[] {
    return list.includes(value)
      ? list.filter((v) => v !== value)
      : [...list, value];
  }

  return (
    <div className="space-y-3 border-t border-slate-100 bg-slate-50 px-4 py-3 dark:border-[#1F1F1F] dark:bg-[#0B0B0B]">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={ruleType}
          onChange={(e) => setRuleType(e.target.value as GateRuleType)}
          className={inputCls}
        >
          {GATE_RULE_TYPES.map((rt) => (
            <option key={rt} value={rt}>
              {GATE_RULE_META[rt].label}
            </option>
          ))}
        </select>
        <select
          value={severity}
          onChange={(e) => setSeverity(e.target.value as GateSeverity)}
          className={inputCls}
        >
          <option value="block">Block</option>
          <option value="warn">Warn</option>
        </select>
      </div>

      <p className="text-[11px] text-slate-500 dark:text-[#A1A1AA]">
        {GATE_RULE_META[ruleType].description}
      </p>

      {/* Config inputs per rule type */}
      {ruleType === 'field_required' ? (
        <div className="flex flex-wrap gap-2">
          {GATE_REQUIRABLE_FIELDS.map((f) => (
            <label
              key={f.key}
              className="flex items-center gap-1.5 text-[12px] text-slate-700 dark:text-[#D4D4D8]"
            >
              <input
                type="checkbox"
                checked={fields.includes(f.key)}
                onChange={() => setFields((l) => toggleIn(l, f.key))}
              />
              {f.label}
            </label>
          ))}
        </div>
      ) : null}

      {ruleType === 'min_stakeholders' ? (
        <label className="flex items-center gap-2 text-[12px] text-slate-700 dark:text-[#D4D4D8]">
          Minimum stakeholders
          <input
            type="number"
            min={1}
            value={count}
            onChange={(e) => setCount(Math.max(1, Number(e.target.value)))}
            className={cn(inputCls, 'w-16')}
          />
        </label>
      ) : null}

      {ruleType === 'min_activities' ? (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-[12px] text-slate-700 dark:text-[#D4D4D8]">
            Minimum activities
            <input
              type="number"
              min={1}
              value={count}
              onChange={(e) => setCount(Math.max(1, Number(e.target.value)))}
              className={cn(inputCls, 'w-16')}
            />
          </label>
          <div className="flex gap-3">
            {GATE_ACTIVITY_TYPES.map((t) => (
              <label
                key={t}
                className="flex items-center gap-1.5 text-[12px] text-slate-700 dark:text-[#D4D4D8]"
              >
                <input
                  type="checkbox"
                  checked={types.includes(t)}
                  onChange={() => setTypes((l) => toggleIn(l, t))}
                />
                {t}
              </label>
            ))}
          </div>
        </div>
      ) : null}

      {ruleType === 'amount_required' ? (
        <label className="flex items-center gap-2 text-[12px] text-slate-700 dark:text-[#D4D4D8]">
          Minimum amount (major units)
          <input
            type="number"
            min={0}
            value={min}
            onChange={(e) => setMin(Math.max(0, Number(e.target.value)))}
            className={cn(inputCls, 'w-24')}
          />
        </label>
      ) : null}

      {ruleType === 'task_complete' ? (
        <label className="flex items-center gap-2 text-[12px] text-slate-700 dark:text-[#D4D4D8]">
          Task type
          <select
            value={taskType}
            onChange={(e) => setTaskType(e.target.value)}
            className={inputCls}
          >
            {GATE_TASK_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {ruleType === 'custom_note' ? (
        <label className="flex flex-col gap-1 text-[12px] text-slate-700 dark:text-[#D4D4D8]">
          Prompt shown to the rep
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className={cn(inputCls, 'w-full')}
          />
        </label>
      ) : null}

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-indigo-500 disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Save rule
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-md px-3 py-1.5 text-[12px] font-medium text-slate-500 hover:text-slate-900 dark:hover:text-[#FAFAFA]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
