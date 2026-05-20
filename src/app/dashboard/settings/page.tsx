import { redirect } from 'next/navigation';

export default function SettingsIndexPage() {
  // Settings root has no own content — bounce to the first section.
  redirect('/dashboard/settings/profile');
}
