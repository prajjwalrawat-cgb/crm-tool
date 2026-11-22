'use client';

import { useRouter } from 'next/navigation';

import { CreateDrawer } from '../../_components/create-drawer';
import { ProspectForm } from './prospect-form';

type Props = {
  offerings: { id: string; name: string }[];
  sourceTags: string[];
};

/** "New prospect" opens the shared right-side create drawer, like "New deal". */
export function NewProspectButton({ offerings, sourceTags }: Props) {
  const router = useRouter();

  return (
    <div className="ml-auto">
      <CreateDrawer
        label="New prospect"
        drawerTitle="New prospect"
        description="Add a potential client to the Dump column."
        widthClass="max-w-xl"
      >
        {(close) => (
          <ProspectForm
            mode="create"
            offerings={offerings}
            sourceTags={sourceTags}
            onCancel={close}
            onSaved={() => {
              close();
              router.refresh();
            }}
          />
        )}
      </CreateDrawer>
    </div>
  );
}
