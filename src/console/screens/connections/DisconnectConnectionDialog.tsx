// "Disconnect …?" (design: the Disconnect sheet of the Connections
// screen): the confirmation of the irreversible (rule 13) over
// DISCONNECT_CONNECTION. Agents lose the account; its tokens are deleted
// here — what the provider still honors is revoked in the provider's own
// settings (the console does not reach there); the account can be
// connected again from the catalog. The dialog stays, busy, while the call
// runs and closes when it ended — the outcome is a toast
// (store/connections/handlers.ts).

import { useEffect, useState } from 'react';
import type { ConnectionView } from '../../../api/contract.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { disconnectConnection } from '../../store/connections/actions.ts';
import { selectConnectionCall } from '../../store/connections/selectors.ts';
import { Confirm } from '../../ui/Confirm/Confirm.tsx';

export function DisconnectConnectionDialog({ connection, onClose }: { connection: ConnectionView; onClose: () => void }) {
  const dispatch = useAppDispatch();
  const call = useAppSelector(s => selectConnectionCall(s, connection.id));
  const [sent, setSent] = useState(false);
  const busy = call !== null;

  useEffect(() => {
    if (sent && !busy) {
      onClose();
    }
  }, [sent, busy, onClose]);

  return (
    <Confirm
      title={`Disconnect ${connection.server} “${connection.displayName}”?`}
      confirm="Disconnect"
      confirmIcon="unplug"
      cancel="Keep"
      busy={busy}
      onConfirm={() => {
        if (busy) {
          return;
        }

        dispatch(disconnectConnection(connection.id));
        setSent(true);
      }}
      onClose={onClose}
    >
      {`Agents lose this account; its tokens are deleted from Balabash. To revoke what ${connection.server} still honors, remove Balabash in ${connection.server}’s own settings. You can connect it again from the catalog.`}
    </Confirm>
  );
}
