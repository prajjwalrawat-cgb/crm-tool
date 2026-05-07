import { OrganizationList } from '@clerk/nextjs';

export const metadata = {
  title: 'Select organization',
};

export default function SelectOrgPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <OrganizationList
        hidePersonal
        afterCreateOrganizationUrl="/dashboard"
        afterSelectOrganizationUrl="/dashboard"
      />
    </main>
  );
}
