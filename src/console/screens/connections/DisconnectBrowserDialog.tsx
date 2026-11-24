// "Disconnect …?": the confirmation of the irreversible over
// DELETE /api/browsers/:id. The browser's record and its secret are deleted
// — in every workspace; its extension forgets the server and stays
// installed. Connecting it again is a new pairing. The dialog stays, busy,
// while the call runs; the outcome is a toast.

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { BrowserView } from '../../../api/contract.ts';
import { toApiFailure } from '../../lib/api/index.ts';
import { useApi } from '../../lib/api/context.tsx';
import { BROWSERS_KEY } from '../../lib/query/browsers.ts';
import { useAppDispatch } from '../../store/hooks.ts';
import { pushToast } from '../../store/ui/actions.ts';
import { Confirm } from '../../ui/Confirm/Confirm.tsx';

export function DisconnectBrowserDialog({ browser, onClose }: { browser: BrowserView; onClose: () => void }) {
  const api = useApi();
  const dispatch = useAppDispatch();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  return (
    <Confirm
      title={`Disconnect “${browser.name}”?`}
      confirm="Disconnect"
      confirmIcon="unplug"
      cancel="Keep"
      busy={busy}
      onConfirm={() => {
        if (busy) {
          return;
        }

        setBusy(true);
        api.browsers
          .disconnect(browser.id)
          .then(
            () => dispatch(pushToast({ title: `“${browser.name}” is disconnected`, desc: 'Its extension stays installed; connect the browser again from this screen.', state: 'done' })),
            error => dispatch(pushToast({ title: `Couldn’t disconnect “${browser.name}”`, desc: toApiFailure(error).message, state: 'err' })),
          )
          .finally(() => {
            void queryClient.invalidateQueries({ queryKey: BROWSERS_KEY });
            onClose();
          });
      }}
      onClose={onClose}
    >
      {'Agents lose this browser in every workspace it is enabled in, and what they are doing in it stops. The extension stays installed and forgets this server; connecting the browser again is a new pairing.'}
    </Confirm>
  );
}
