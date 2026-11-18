'use client';

import { Eye, EyeOff, Plus, RefreshCw, Send, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { LEAD_FIELD_KEYS, LEAD_SOURCE_TYPES, type LeadSourceType } from '@/lib/lead-capture/constants';
import { cn } from '@/lib/utils';

import {
  createLeadSourceAction,
  retryIngestEventAction,
  rotateLeadSourceSecretAction,
  sendTestLeadAction,
  setLeadSourceActiveAction,
  updateLeadSourceAction,
} from '../../lead-capture/actions';
import { Badge, Button, Card, CodeBlock, CopyButton, EmptyState, Field, formatWhen, inputCls, selectCls, Toggle } from '../../lead-capture/_components/ui';

export type SourceView = {
  id: string;
  name: string;
  type: LeadSourceType;
  isActive: boolean;
  secretToken: string;
  fieldMapping: Record<string, string>;
  defaultRuleId: string | null;
  allowedOrigins: string[];
  config: { page_id: string; form_ids: string[]; hasPageToken: boolean };
  lastEventAt: string | null;
  events7d: number;
  failed7d: number;
};

type EventView = {
  id: string;
  sourceId: string;
  status: string;
  error: string | null;
  dealId: string | null;
  receivedAt: string;
  attempts: number;
  preview: string;
};

const TYPE_LABEL: Record<LeadSourceType, string> = {
  web_form: 'Web form',
  landing_page: 'Landing page',
  webhook: 'Webhook / API',
  csv_import: 'CSV import',
  api: 'API',
  manual: 'Manual',
  meta_ads: 'Meta lead ads',
  google_ads: 'Google ads',
  portal: 'Portal (IndiaMART, JustDial …)',
};

const FIELD_LABEL: Record<string, string> = {
  full_name: 'Full name',
  first_name: 'First name',
  last_name: 'Last name',
  email: 'Email',
  phone: 'Phone',
  company: 'Company',
  title: 'Job title',
  city: 'City',
  state: 'State',
  product_interest: 'Product interest',
  message: 'Message',
  utm_source: 'UTM source',
  utm_medium: 'UTM medium',
  utm_campaign: 'UTM campaign',
  utm_term: 'UTM term',
  utm_content: 'UTM content',
  landing_url: 'Landing URL',
  referrer_url: 'Referrer URL',
  consent: 'Consent',
};

export function LeadSourcesManager({
  origin,
  tenantSlug,
  sources,
  rules,
  forms,
  events,
}: {
  origin: string;
  tenantSlug: string;
  sources: SourceView[];
  rules: Array<{ id: string; name: string }>;
  forms: Array<{ id: string; slug: string; title: string; sourceId: string; isPublished: boolean }>;
  events: EventView[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selectedId, setSelectedId] = useState<string | null>(sources[0]?.id ?? null);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<LeadSourceType>('webhook');
  const selected = sources.find((s) => s.id === selectedId) ?? null;

  function create() {
    if (!newName.trim()) {
      toast.error('Give the source a name');
      return;
    }
    startTransition(async () => {
      const r = await createLeadSourceAction({ name: newName.trim(), type: newType });
      if (!r.ok) return void toast.error(r.message);
      toast.success('Source created');
      setNewName('');
      if (r.data) setSelectedId(r.data.id);
      router.refresh();
    });
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[18rem_minmax(0,1fr)]">
      <div className="space-y-3">
        <Card title="Sources">
          {sources.length === 0 ? (
            <EmptyState title="No sources yet">Create one below to get an endpoint.</EmptyState>
          ) : (
            <ul className="space-y-1">
              {sources.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(s.id)}
                    aria-current={s.id === selectedId ? 'true' : undefined}
                    className={cn(
                      'w-full rounded-md px-2.5 py-2 text-left transition',
                      s.id === selectedId ? 'bg-indigo-50 dark:bg-indigo-500/10' : 'hover:bg-slate-50 dark:hover:bg-[#181818]',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[13px] font-medium text-slate-900 dark:text-[#FAFAFA]">{s.name}</span>
                      <Badge tone={s.isActive ? 'active' : 'inactive'}>{s.isActive ? 'On' : 'Off'}</Badge>
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
                      {TYPE_LABEL[s.type]} · {s.events7d} in 7d{s.failed7d ? ` · ${s.failed7d} failed` : ''}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="New source">
          <div className="space-y-2">
            <Field label="Name" htmlFor="new-source-name">
              <input id="new-source-name" className={inputCls} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Website contact form" />
            </Field>
            <Field label="Type" htmlFor="new-source-type">
              <select id="new-source-type" className={selectCls} value={newType} onChange={(e) => setNewType(e.target.value as LeadSourceType)}>
                {LEAD_SOURCE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            </Field>
            <Button variant="primary" onClick={create} disabled={pending} className="w-full">
              <Plus className="h-3.5 w-3.5" aria-hidden /> Create source
            </Button>
          </div>
        </Card>
      </div>

      {selected ? (
        <SourceDetail
          key={selected.id}
          source={selected}
          origin={origin}
          tenantSlug={tenantSlug}
          rules={rules}
          forms={forms.filter((f) => f.sourceId === selected.id)}
          events={events.filter((e) => e.sourceId === selected.id).slice(0, 50)}
        />
      ) : (
        <EmptyState title="Pick or create a source" />
      )}
    </div>
  );
}

function SourceDetail({
  source,
  origin,
  tenantSlug,
  rules,
  forms,
  events,
}: {
  source: SourceView;
  origin: string;
  tenantSlug: string;
  rules: Array<{ id: string; name: string }>;
  forms: Array<{ id: string; slug: string; title: string; isPublished: boolean }>;
  events: EventView[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [reveal, setReveal] = useState(false);
  const [name, setName] = useState(source.name);
  const [type, setType] = useState<LeadSourceType>(source.type);
  const [defaultRuleId, setDefaultRuleId] = useState(source.defaultRuleId ?? '');
  const [origins, setOrigins] = useState(source.allowedOrigins.join('\n'));
  const [mapping, setMapping] = useState<Array<{ from: string; to: string }>>(
    Object.entries(source.fieldMapping).map(([from, to]) => ({ from, to })),
  );
  const [pageId, setPageId] = useState(source.config.page_id);
  const [formIds, setFormIds] = useState(source.config.form_ids.join(', '));
  const [pageToken, setPageToken] = useState('');

  const endpoint = `${origin}/api/public/ingest/${source.id}`;
  const metaEndpoint = `${origin}/api/public/meta/${source.id}/webhook`;
  const secretShown = reveal ? source.secretToken : `${source.secretToken.slice(0, 6)}${'•'.repeat(20)}`;
  const sampleBody = '{"name":"Ravi Kumar","mobile":"+91 98765 43210","email":"ravi@example.com","company":"Acme Castings","city":"Pune","product":"Induction furnace","utm_source":"google"}';
  const curlToken = `curl -X POST "${endpoint}" \\\n  -H "Content-Type: application/json" \\\n  -H "X-Saleinx-Token: ${reveal ? source.secretToken : '<secret>'}" \\\n  -d '${sampleBody}'`;
  const curlHmac = `BODY='${sampleBody}'\nSIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "${reveal ? source.secretToken : '<secret>'}" -hex | sed 's/^.* //')\ncurl -X POST "${endpoint}" \\\n  -H "Content-Type: application/json" \\\n  -H "X-Saleinx-Signature: sha256=$SIG" \\\n  --data-raw "$BODY"`;

  const dirty = useMemo(
    () =>
      name !== source.name ||
      type !== source.type ||
      (defaultRuleId || null) !== source.defaultRuleId ||
      origins.trim() !== source.allowedOrigins.join('\n') ||
      JSON.stringify(Object.fromEntries(mapping.filter((m) => m.from.trim()).map((m) => [m.from.trim(), m.to]))) !== JSON.stringify(source.fieldMapping) ||
      pageId !== source.config.page_id ||
      formIds !== source.config.form_ids.join(', ') ||
      pageToken !== '',
    [name, type, defaultRuleId, origins, mapping, pageId, formIds, pageToken, source],
  );

  function run(fn: () => Promise<{ ok: boolean; message?: string }>, ok: string) {
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) return void toast.error(r.message ?? 'Something went wrong');
      toast.success(ok);
      router.refresh();
    });
  }

  function save() {
    run(
      () =>
        updateLeadSourceAction(source.id, {
          name,
          type,
          defaultRuleId: defaultRuleId || null,
          allowedOrigins: origins.split(/[\s,]+/).map((o) => o.trim()).filter(Boolean),
          fieldMapping: Object.fromEntries(mapping.filter((m) => m.from.trim() && m.to).map((m) => [m.from.trim(), m.to])),
          config: {
            ...(pageId.trim() ? { page_id: pageId.trim() } : {}),
            ...(formIds.trim() ? { form_ids: formIds.split(',').map((x) => x.trim()).filter(Boolean) } : {}),
            ...(pageToken.trim() ? { page_token: pageToken.trim() } : {}),
          },
        }),
      'Source saved',
    );
    setPageToken('');
  }

  return (
    <div className="space-y-4">
      <Card
        title={source.name}
        description={`${TYPE_LABEL[source.type]} · last lead ${formatWhen(source.lastEventAt)}`}
        actions={
          <>
            <span className="text-[12px] text-slate-600 dark:text-[#A1A1AA]">Active</span>
            <Toggle
              label="Source active"
              checked={source.isActive}
              disabled={pending}
              onChange={(v) => run(() => setLeadSourceActiveAction(source.id, v), v ? 'Source turned on' : 'Source turned off — new payloads get 404')}
            />
            <Button onClick={() => run(() => sendTestLeadAction(source.id), 'Test lead sent — refresh in a few seconds')} disabled={pending || !source.isActive}>
              <Send className="h-3.5 w-3.5" aria-hidden /> Send test lead
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Endpoint URL">
            <div className="flex items-center gap-1">
              <input readOnly className={cn(inputCls, 'font-mono text-[12px]')} value={endpoint} aria-label="Endpoint URL" />
              <CopyButton value={endpoint} />
            </div>
          </Field>
          <Field label="Secret" hint="Send it as X-Saleinx-Token, or sign the raw body with it (HMAC-SHA256) as X-Saleinx-Signature. Rotating breaks every integration using the old secret.">
            <div className="flex items-center gap-1">
              <input readOnly className={cn(inputCls, 'font-mono text-[12px]')} value={secretShown} aria-label="Secret" />
              <Button variant="ghost" onClick={() => setReveal((v) => !v)} aria-label={reveal ? 'Hide secret' : 'Show secret'}>
                {reveal ? <EyeOff className="h-3.5 w-3.5" aria-hidden /> : <Eye className="h-3.5 w-3.5" aria-hidden />}
              </Button>
              <CopyButton value={source.secretToken} />
              <Button
                variant="danger"
                disabled={pending}
                onClick={() => {
                  if (confirm('Rotate the secret? Integrations using the current one will start getting 401.')) {
                    run(() => rotateLeadSourceSecretAction(source.id), 'Secret rotated');
                  }
                }}
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Rotate
              </Button>
            </div>
          </Field>
          <details className="group">
            <summary className="cursor-pointer text-[12.5px] font-medium text-indigo-600 dark:text-indigo-400">curl examples</summary>
            <div className="mt-2 space-y-2">
              <CodeBlock code={curlToken} />
              <CodeBlock code={curlHmac} />
            </div>
          </details>
          {source.type === 'meta_ads' ? (
            <Field label="Meta webhook callback URL" hint="In your Meta app: Webhooks → Page → subscribe to leadgen. Verify token = this source's secret. Requires META_APP_SECRET on the server.">
              <div className="flex items-center gap-1">
                <input readOnly className={cn(inputCls, 'font-mono text-[12px]')} value={metaEndpoint} aria-label="Meta webhook URL" />
                <CopyButton value={metaEndpoint} />
              </div>
            </Field>
          ) : null}
          {forms.length > 0 ? (
            <Field label="Embed snippets">
              <div className="space-y-2">
                {forms.map((f) => (
                  <div key={f.id}>
                    <div className="mb-1 text-[12px] text-slate-600 dark:text-[#A1A1AA]">
                      {f.title} {f.isPublished ? null : <Badge tone="inactive">not published</Badge>}
                    </div>
                    <CodeBlock code={`<div data-saleinx-form="${tenantSlug}/${f.slug}"></div>\n<script src="${origin}/embed/form.js" async></script>`} />
                  </div>
                ))}
              </div>
            </Field>
          ) : null}
        </div>
      </Card>

      <Card title="Settings" actions={<Button variant="primary" onClick={save} disabled={pending || !dirty}>Save changes</Button>}>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Name" htmlFor="src-name">
            <input id="src-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Type" htmlFor="src-type">
            <select id="src-type" className={selectCls} value={type} onChange={(e) => setType(e.target.value as LeadSourceType)}>
              {LEAD_SOURCE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Fallback distribution rule" hint="Used when no prioritized rule matches a lead from this source." htmlFor="src-rule">
            <select id="src-rule" className={selectCls} value={defaultRuleId} onChange={(e) => setDefaultRuleId(e.target.value)}>
              <option value="">Workspace default</option>
              {rules.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Allowed origins (embedded forms)" hint="One per line, e.g. https://www.yourcompany.com. Cross-origin form submits from anywhere else are refused." htmlFor="src-origins">
            <textarea id="src-origins" className={cn(inputCls, 'min-h-[68px] font-mono text-[12px]')} value={origins} onChange={(e) => setOrigins(e.target.value)} />
          </Field>
          {type === 'meta_ads' ? (
            <>
              <Field label="Facebook page id" htmlFor="src-page">
                <input id="src-page" className={inputCls} value={pageId} onChange={(e) => setPageId(e.target.value)} />
              </Field>
              <Field label="Lead form ids (optional, comma-separated)" htmlFor="src-forms">
                <input id="src-forms" className={inputCls} value={formIds} onChange={(e) => setFormIds(e.target.value)} />
              </Field>
              <Field
                label="Page access token"
                hint={source.config.hasPageToken ? 'A token is saved. Paste a new one to replace it.' : 'Needed to fetch the lead’s fields from the Graph API.'}
                htmlFor="src-token"
              >
                <input id="src-token" type="password" autoComplete="off" className={inputCls} value={pageToken} onChange={(e) => setPageToken(e.target.value)} />
              </Field>
            </>
          ) : null}
        </div>

        <div className="mt-4">
          <div className="mb-1 text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">Field mapping</div>
          <p className="mb-2 text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
            Common field names (name, mobile, email, SENDER_MOBILE, QUERY_PRODUCT_NAME …) are recognised automatically.
            Add a row only for names that aren&apos;t, or to send a field into a custom field.
          </p>
          <div className="space-y-1.5">
            {mapping.map((m, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  className={cn(inputCls, 'font-mono text-[12px]')}
                  placeholder="inbound field name"
                  aria-label="Inbound field name"
                  value={m.from}
                  onChange={(e) => setMapping((rows) => rows.map((r, j) => (j === i ? { ...r, from: e.target.value } : r)))}
                />
                <span aria-hidden className="text-slate-400">→</span>
                <MappingTarget value={m.to} onChange={(to) => setMapping((rows) => rows.map((r, j) => (j === i ? { ...r, to } : r)))} />
                <Button variant="ghost" aria-label="Remove mapping" onClick={() => setMapping((rows) => rows.filter((_, j) => j !== i))}>
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </div>
            ))}
            <Button onClick={() => setMapping((rows) => [...rows, { from: '', to: 'phone' }])}>
              <Plus className="h-3.5 w-3.5" aria-hidden /> Add mapping
            </Button>
          </div>
        </div>
      </Card>

      <Card title="Recent payloads" description="Last 50 received on this source. Field names only — payload values stay in the database.">
        {events.length === 0 ? (
          <EmptyState title="Nothing received yet">Send a test lead or point an integration at the endpoint.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12.5px]">
              <thead className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">Received</th>
                  <th className="py-1.5 pr-3 font-medium">Status</th>
                  <th className="py-1.5 pr-3 font-medium">Fields</th>
                  <th className="py-1.5 pr-3 font-medium">Result</th>
                  <th className="py-1.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-[#1F1F1F]">
                {events.map((e) => (
                  <tr key={e.id}>
                    <td className="py-1.5 pr-3 whitespace-nowrap text-slate-600 dark:text-[#A1A1AA]">{formatWhen(e.receivedAt)}</td>
                    <td className="py-1.5 pr-3">
                      <Badge tone={e.status}>{e.status}</Badge>
                    </td>
                    <td className="max-w-[16rem] truncate py-1.5 pr-3 font-mono text-[11.5px] text-slate-500" title={e.preview}>
                      {e.preview || '—'}
                    </td>
                    <td className="py-1.5 pr-3">
                      {e.dealId ? (
                        <Link className="text-indigo-600 hover:underline dark:text-indigo-400" href={`/dashboard/deals/${e.dealId}`}>
                          Open lead
                        </Link>
                      ) : (
                        <span className="text-rose-700 dark:text-rose-300">{e.error ?? '—'}</span>
                      )}
                    </td>
                    <td className="py-1.5 text-right">
                      {e.status === 'failed' ? (
                        <Button disabled={pending} onClick={() => run(() => retryIngestEventAction(e.id), 'Retrying')}>
                          Retry
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function MappingTarget({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const isCustom = value.startsWith('custom.');
  return (
    <div className="flex w-full items-center gap-1">
      <select
        className={selectCls}
        aria-label="Lead field"
        value={isCustom ? '__custom' : value}
        onChange={(e) => onChange(e.target.value === '__custom' ? 'custom.' : e.target.value)}
      >
        {LEAD_FIELD_KEYS.map((k) => (
          <option key={k} value={k}>
            {FIELD_LABEL[k] ?? k}
          </option>
        ))}
        <option value="__custom">Custom field…</option>
      </select>
      {isCustom ? (
        <input
          className={cn(inputCls, 'font-mono text-[12px]')}
          aria-label="Custom field key"
          placeholder="key"
          value={value.slice('custom.'.length)}
          onChange={(e) => onChange(`custom.${e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`)}
        />
      ) : null}
    </div>
  );
}
