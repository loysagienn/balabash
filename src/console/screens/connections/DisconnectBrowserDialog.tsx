// "Disconnect …?": the confirmation of the irreversible over
// DELETE /api/browsers/:id. The browser's record and its secret are deleted
// — it leaves every workspace, its sessions end; its extension forgets the
// server and stays installed. Using it again is a new pairing from that
// Chrome. The dialog stays, busy, while the call runs; the outcome is a
// toast.

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { BrowserView } from '../../../api/contract.ts';
import { toApiFailure } from '../../lib/api/index.ts';
import { useApi } from '../../lib/api/context.tsx';
import { BROWSERS_KEY } from '../../lib/query/browsers.ts';
import { disconnectFailedWords, disconnectedWords } from '../../store/browsers/words.ts';
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
            () => dispatch(pushToast(disconnectedWords(browser.name))),
            error => dispatch(pushToast(disconnectFailedWords(browser.name, toApiFailure(error)))),
          )
          .finally(() => {
            void queryClient.invalidateQueries({ queryKey: BROWSERS_KEY });
            onClose();
          });
      }}
      onClose={onClose}
    >
      {'It leaves every workspace and every agent session in it ends; the extension in that Chrome stops being connected. To use it again, connect it anew from that Chrome.'}
    </Confirm>
  );
}
