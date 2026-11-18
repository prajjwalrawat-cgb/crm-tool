'use client';

import { Copy, Loader2, PhoneCall, RefreshCw, Trash2, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition, type ReactNode } from 'react';
import { toast } from 'sonner';

import type { CallingHours, TelephonyProviderName } from '@/db/schema/telephony';

import {
  mapUserPhone,
  placeTestCall,
  removeDncNumber,
  rotateWebhookSecret,
  saveTelephonyAccount,
  saveTelephonySettings,
  unmapUserPhone,
  uploadDncList,
} from '../../../telephony/actions';

type Account = { id: string; provider: TelephonyProviderName; label: string | null; virtualNumbers: string[]; isActive: boolean; webhookUrl: string };
type Settings = { recordCalls: boolean; recordingAnnouncement: boolean; consentPolicyVersion: string; aiCallSummary: boolean; enforceDnc: boolean; callingHours: CallingHours };

const input = 'w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-[13px] dark:border-[#1F1F1F] dark:bg-black';
const btn = 'inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-indigo-500 disabled:opacity-50';
const btnGhost = 'inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[12px] text-slate-600 hover:border-slate-300 dark:border-[#1F1F1F] dark:text-[#A1A1AA]';

function Card({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
      <h2 className="text-[13px] font-semibold text-slate-900 dark:text-[#FAFAFA]">{title}</h2>
      {description ? <p className="mt-0.5 text-[12px] text-slate-500 dark:text-[#A1A1AA]">{description}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function TelephonySettingsManager(props: {
  kmsConfigured: boolean;
  implementedProviders: TelephonyProviderName[];
  settings: Settings;
  accounts: Account[];
  members: Array<{ id: string; name: string; email: string | null }>;
  mappings: Array<{ userId: string; agentPhone: string; agentExt: string | null; agentStatus: string }>;
  dnc: Array<{ phone: string; reason: string | null; addedAt: string }>;
  dncTotal: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; message?: string }>, success: string) =>
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) return void toast.error(r.message ?? 'Something went wrong');
      toast.success(success);
      router.refresh();
    });

  // ---- account form
  const existing = props.accounts[0];
  const [acct, setAcct] = useState({
    provider: (existing?.provider ?? 'exotel') as TelephonyProviderName,
    label: existing?.label ?? '',
    accountSid: '',
    apiKey: '',
    apiToken: '',
    subdomain: 'api.in.exotel.com',
    numbers: existing?.virtualNumbers.join(', ') ?? '',
    isActive: existing?.isActive ?? true,
  });
  // ---- settings form
  const [s, setS] = useState(props.settings);
  // ---- mapping form
  const [mapUser, setMapUser] = useState('');
  const [mapPhone, setMapPhone] = useState('');
  const [testPhone, setTestPhone] = useState('');
  const memberName = (id: string) => props.members.find((m) => m.id === id)?.name ?? id;

  return (
    <div className="space-y-4">
      {!props.kmsConfigured ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <strong>KMS_KEY</strong> is not set on the server. Credentials can&apos;t be saved until it is (64 hex characters, or a base64 32-byte key).
        </p>
      ) : null}

      <Card title="Provider account" description="Exotel: find the Account SID, API key and API token under Settings → API Settings in the Exotel dashboard. India accounts use api.in.exotel.com.">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-[12px] text-slate-600 dark:text-[#A1A1AA]">
            Provider
            <select className={input} value={acct.provider} onChange={(e) => setAcct({ ...acct, provider: e.target.value as TelephonyProviderName })}>
              {(['exotel', 'knowlarity', 'ozonetel', 'myoperator', 'twilio'] as const).map((p) => (
                <option key={p} value={p} disabled={!props.implementedProviders.includes(p)}>
                  {p}
                  {props.implementedProviders.includes(p) ? '' : ' (coming later)'}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[12px] text-slate-600 dark:text-[#A1A1AA]">
            Label
            <input className={input} value={acct.label} onChange={(e) => setAcct({ ...acct, label: e.target.value })} placeholder="Sales line" />
          </label>
          <label className="text-[12px] text-slate-600 dark:text-[#A1A1AA]">
            Account SID
            <input className={input} value={acct.accountSid} onChange={(e) => setAcct({ ...acct, accountSid: e.target.value })} placeholder={existing ? 'saved — leave blank to keep' : ''} autoComplete="off" />
          </label>
          <label className="text-[12px] text-slate-600 dark:text-[#A1A1AA]">
            API region
            <select className={input} value={acct.subdomain} onChange={(e) => setAcct({ ...acct, subdomain: e.target.value })}>
              <option value="api.in.exotel.com">Mumbai (api.in.exotel.com)</option>
              <option value="api.exotel.com">Singapore (api.exotel.com)</option>
            </select>
          </label>
          <label className="text-[12px] text-slate-600 dark:text-[#A1A1AA]">
            API key
            <input className={input} value={acct.apiKey} onChange={(e) => setAcct({ ...acct, apiKey: e.target.value })} placeholder={existing ? 'saved — leave blank to keep' : ''} autoComplete="off" />
          </label>
          <label className="text-[12px] text-slate-600 dark:text-[#A1A1AA]">
            API token
            <input type="password" className={input} value={acct.apiToken} onChange={(e) => setAcct({ ...acct, apiToken: e.target.value })} placeholder={existing ? 'saved — leave blank to keep' : ''} autoComplete="new-password" />
          </label>
          <label className="text-[12px] text-slate-600 sm:col-span-2 dark:text-[#A1A1AA]">
            Caller ids (ExoPhones), comma-separated
            <input className={input} value={acct.numbers} onChange={(e) => setAcct({ ...acct, numbers: e.target.value })} placeholder="+91 80 4718 xxxx" />
          </label>
          <label className="flex items-center gap-2 text-[12px] text-slate-600 dark:text-[#A1A1AA]">
            <input type="checkbox" checked={acct.isActive} onChange={(e) => setAcct({ ...acct, isActive: e.target.checked })} />
            Active
          </label>
        </div>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            disabled={pending || !props.kmsConfigured}
            className={btn}
            onClick={() =>
              run(
                () =>
                  saveTelephonyAccount({
                    id: existing?.id ?? null,
                    provider: acct.provider,
                    label: acct.label || null,
                    accountSid: acct.accountSid || undefined,
                    apiKey: acct.apiKey || undefined,
                    apiToken: acct.apiToken || undefined,
                    subdomain: acct.subdomain,
                    virtualNumbers: acct.numbers.split(',').map((n) => n.trim()).filter(Boolean),
                    isActive: acct.isActive,
                  }),
                'Account saved',
              )
            }
          >
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            Save account
          </button>
        </div>

        {props.accounts.map((a) => (
          <div key={a.id} className="mt-4 rounded-md border border-slate-200 p-3 text-[12px] dark:border-[#1F1F1F]">
            <p className="font-medium text-slate-800 dark:text-[#E4E4E7]">
              Webhook URL {a.label ? `· ${a.label}` : ''} {a.isActive ? '' : '(inactive)'}
            </p>
            <p className="mt-0.5 text-slate-500 dark:text-[#A1A1AA]">
              Used automatically as the StatusCallback for outbound calls. For inbound calls, add a Passthru applet to your ExoPhone&apos;s call flow pointing at this URL. The <code>s=</code> part is the secret — treat the URL like a password.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-slate-100 px-2 py-1 text-[11px] dark:bg-[#181818]">{a.webhookUrl}</code>
              <button type="button" className={btnGhost} onClick={() => void navigator.clipboard.writeText(a.webhookUrl).then(() => toast.success('Copied'))}>
                <Copy className="h-3 w-3" aria-hidden /> Copy
              </button>
              <button
                type="button"
                className={btnGhost}
                disabled={pending}
                onClick={() => window.confirm('Rotate the secret? Update the URL in Exotel afterwards, or inbound events will be rejected.') && run(() => rotateWebhookSecret(a.id), 'Secret rotated')}
              >
                <RefreshCw className="h-3 w-3" aria-hidden /> Rotate
              </button>
            </div>
          </div>
        ))}

        {existing ? (
          <div className="mt-4 flex flex-wrap items-end gap-2">
            <label className="text-[12px] text-slate-600 dark:text-[#A1A1AA]">
              Test call: rings your mapped phone, then this number
              <input className={input} value={testPhone} onChange={(e) => setTestPhone(e.target.value)} placeholder="+91 98xxx xxxxx" />
            </label>
            <button type="button" className={btnGhost} disabled={pending || !testPhone} onClick={() => run(() => placeTestCall(testPhone), 'Test call started — your phone will ring')}>
              <PhoneCall className="h-3 w-3" aria-hidden /> Place test call
            </button>
          </div>
        ) : null}
      </Card>

      <Card title="Calling policy" description="These are product settings. They do not by themselves make calling compliant — see the note below.">
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-[12px] text-slate-600 dark:text-[#A1A1AA]">
            Calling hours start
            <input type="time" className={input} value={s.callingHours.start} onChange={(e) => setS({ ...s, callingHours: { ...s.callingHours, start: e.target.value } })} />
          </label>
          <label className="text-[12px] text-slate-600 dark:text-[#A1A1AA]">
            Calling hours end
            <input type="time" className={input} value={s.callingHours.end} onChange={(e) => setS({ ...s, callingHours: { ...s.callingHours, end: e.target.value } })} />
          </label>
          <label className="text-[12px] text-slate-600 dark:text-[#A1A1AA]">
            Timezone
            <input className={input} value={s.callingHours.tz} onChange={(e) => setS({ ...s, callingHours: { ...s.callingHours, tz: e.target.value } })} />
          </label>
        </div>
        <div className="mt-3 space-y-2 text-[12px] text-slate-700 dark:text-[#E4E4E7]">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.recordCalls} onChange={(e) => setS({ ...s, recordCalls: e.target.checked })} /> Record calls
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.recordingAnnouncement} onChange={(e) => setS({ ...s, recordingAnnouncement: e.target.checked })} /> Play a &quot;calls may be recorded&quot; announcement (configure the audio in your provider&apos;s call flow)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.enforceDnc} onChange={(e) => setS({ ...s, enforceDnc: e.target.checked })} /> Block calls to numbers on the do-not-call list
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.aiCallSummary} onChange={(e) => setS({ ...s, aiCallSummary: e.target.checked })} />
            AI call summaries — sends call transcripts to Anthropic (Claude) for a summary. Off by default; also needs a speech-to-text engine configured on the server.
          </label>
          <label className="flex items-center gap-2">
            Consent policy version
            <input className={`${input} w-32`} value={s.consentPolicyVersion} onChange={(e) => setS({ ...s, consentPolicyVersion: e.target.value })} />
          </label>
        </div>
        <p className="mt-3 text-[11px] text-slate-500 dark:text-[#A1A1AA]">
          Your organisation is responsible for scrubbing numbers against the national DND/NDNC registry and for following TRAI and recording-consent rules. Saleinx only blocks numbers on this workspace&apos;s own list.
        </p>
        <div className="mt-3 flex justify-end">
          <button type="button" disabled={pending} className={btn} onClick={() => run(() => saveTelephonySettings(s), 'Settings saved')}>
            Save policy
          </button>
        </div>
      </Card>

      <Card title="Agent phones" description="The number the provider rings first when an agent clicks Call. Agents without a mapping can't place calls and don't see the softphone bar.">
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-[12px] text-slate-600 dark:text-[#A1A1AA]">
            Member
            <select className={input} value={mapUser} onChange={(e) => setMapUser(e.target.value)}>
              <option value="">Pick a member…</option>
              {props.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[12px] text-slate-600 dark:text-[#A1A1AA]">
            Phone
            <input className={input} value={mapPhone} onChange={(e) => setMapPhone(e.target.value)} placeholder="+91 98xxx xxxxx" />
          </label>
          <button type="button" className={btn} disabled={pending || !mapUser || !mapPhone} onClick={() => run(() => mapUserPhone({ userId: mapUser, agentPhone: mapPhone }), 'Phone mapped')}>
            Save mapping
          </button>
        </div>
        <table className="mt-3 w-full text-[12px]">
          <thead className="text-left text-slate-400">
            <tr>
              <th className="py-1 font-medium">Member</th>
              <th className="py-1 font-medium">Phone</th>
              <th className="py-1 font-medium">Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {props.mappings.map((m) => (
              <tr key={m.userId} className="border-t border-slate-100 dark:border-[#181818]">
                <td className="py-1.5">{memberName(m.userId)}</td>
                <td className="py-1.5 font-mono">{m.agentPhone}</td>
                <td className="py-1.5">{m.agentStatus.replace('_', ' ')}</td>
                <td className="py-1.5 text-right">
                  <button type="button" aria-label="Remove mapping" className="text-slate-400 hover:text-rose-600" onClick={() => run(() => unmapUserPhone(m.userId), 'Mapping removed')}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </td>
              </tr>
            ))}
            {props.mappings.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-2 text-slate-400">No agents mapped yet.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Card>

      <Card title={`Do-not-call list (${props.dncTotal})`} description="Upload a CSV or a plain list, one number per line. Numbers are stored in E.164; matching numbers are removed from running dialer campaigns.">
        <label className={`${btnGhost} cursor-pointer`}>
          <Upload className="h-3 w-3" aria-hidden /> Upload list
          <input
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const text = await f.text();
              startTransition(async () => {
                const r = await uploadDncList(text);
                if (!r.ok) return void toast.error(r.message);
                toast.success(`Added ${r.added} number(s)${r.invalid ? `, skipped ${r.invalid} invalid` : ''}`);
                router.refresh();
              });
              e.target.value = '';
            }}
          />
        </label>
        <ul className="mt-3 max-h-64 divide-y divide-slate-100 overflow-auto text-[12px] dark:divide-[#181818]">
          {props.dnc.map((d) => (
            <li key={d.phone} className="flex items-center gap-2 py-1">
              <span className="font-mono">{d.phone}</span>
              <span className="truncate text-slate-400">{d.reason}</span>
              <button type="button" aria-label={`Remove ${d.phone}`} className="ml-auto text-slate-400 hover:text-rose-600" onClick={() => run(() => removeDncNumber(d.phone), 'Removed')}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
