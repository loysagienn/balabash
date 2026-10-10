// "Unpublish …?" (design: AppsScreen sheet): the confirmation of the
// irreversible (rule 13) over UNPUBLISH_APP. The question names the link
// that stops working; "Keep" leaves everything. The dialog stays, busy,
// while the call runs and closes when it ended — the outcome is a toast
// (store/apps/handlers.ts), there is no form to show a refusal in.

import { useEffect, useState } from 'react';
import type { AppListingView } from '../../../api/contract.ts';
import { appTitle, appUrlText } from '../../lib/apps/appLink.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { unpublishApp } from '../../store/apps/actions.ts';
import { selectAppCall } from '../../store/apps/selectors.ts';
import { Confirm } from '../../ui/Confirm/Confirm.tsx';
import { unpublishWords } from './publishApp.logic.ts';

export function UnpublishAppDialog({ app, address, onClose }: { app: AppListingView; address: string; onClose: () => void }) {
  const dispatch = useAppDispatch();
  const call = useAppSelector(s => selectAppCall(s, app.path));
  const [sent, setSent] = useState(false);
  const busy = call !== null;

  useEffect(() => {
    if (sent && !busy) {
      onClose();
    }
  }, [sent, busy, onClose]);

  return (
    <Confirm
      title={`Unpublish “${appTitle(app)}”?`}
      confirm="Unpublish"
      confirmIcon="globe-lock"
      cancel="Keep"
      busy={busy}
      onConfirm={() => {
        if (busy) {
          return;
        }

        dispatch(unpublishApp(app.path));
        setSent(true);
      }}
      onClose={onClose}
    >
      {unpublishWords(appUrlText(address))}
    </Confirm>
  );
}
