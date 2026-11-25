'use client';

import { ImageIcon, Loader2, Upload } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { removeOrganizationLogoAction, uploadOrganizationLogoAction } from '../../actions';
import { SettingsCard, SettingsSection } from '../../_components/settings-form';

/** Workspace logo: uploads and removals save immediately (not part of the Save bar). */
export function OrganizationLogo({ initialUrl }: { initialUrl: string | null }) {
  const [logo, setLogo] = useState(initialUrl);
  const [busy, setBusy] = useState(false);

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    const fd = new FormData();
    fd.append('file', file);
    const res = await uploadOrganizationLogoAction(fd);
    setBusy(false);
    if (res.ok) {
      setLogo(res.url);
      toast.success('Logo saved');
    } else toast.error(res.error);
  }

  async function remove() {
    setBusy(true);
    const res = await removeOrganizationLogoAction();
    setBusy(false);
    if (res.ok) {
      setLogo(null);
      toast.success('Logo removed');
    } else toast.error(res.error);
  }

  return (
    <SettingsCard>
      <SettingsSection title="Logo" description="Printed on this workspace's invoices and quotes." icon={ImageIcon}>
        <div className="flex items-center gap-4 pt-1">
          <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50 dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
            {logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo} alt="Workspace logo" className="h-full w-full object-contain" />
            ) : (
              <ImageIcon className="h-6 w-6 text-slate-300" aria-hidden />
            )}
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-3">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-slate-200 px-3 py-1.5 text-[12.5px] font-medium text-slate-700 transition hover:bg-slate-50 dark:border-[#1F1F1F] dark:text-[#FAFAFA] dark:hover:bg-[#181818]">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Upload className="h-4 w-4" aria-hidden />}
                {logo ? 'Replace logo' : 'Upload logo'}
                <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={upload} disabled={busy} />
              </label>
              {logo ? (
                <button type="button" onClick={remove} disabled={busy} className="text-[12px] text-red-600 hover:underline disabled:opacity-60">
                  Remove
                </button>
              ) : null}
            </div>
            <p className="text-[11px] text-slate-400">PNG, JPG or WebP, up to 2 MB.</p>
          </div>
        </div>
      </SettingsSection>
    </SettingsCard>
  );
}
