// One account of an external service (design: the row of the Connections
// "Accounts" card): the service's icon tinted by what the row asks of the
// user, the name in Balabash, the meta line (service · identity · since
// when), the granted scopes as chips or, for a sign-in not finished, a
// line on how to continue, the flow's last error; on the right — the
// button of the moment (a held sign-in link to open in a new tab, "Sign in"
// for an account the provider rejects, "New link" for a pending one), the
// status badge and the "⋯" menu: rename, reconnect, disconnect. The row
// carries its own buttons, so it is not a link.

import { useState } from 'react';
import type { ConnectionView } from '../../../api/contract.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { reconnectConnection } from '../../store/connections/actions.ts';
import { selectConnectionCall, selectConnectionFailure, selectConnectionLink } from '../../store/connections/selectors.ts';
import { Badge } from '../../ui/Badge/Badge.tsx';
import { Btn } from '../../ui/Btn/Btn.tsx';
import { IconBtn } from '../../ui/IconBtn/IconBtn.tsx';
import { Row } from '../../ui/List/List.tsx';
import { Menu, MenuAnchor, MenuItem } from '../../ui/Menu/Menu.tsx';
import { Obj } from '../../ui/Obj/Obj.tsx';
import { Code, ErrorLine, Quiet } from '../../ui/atoms/atoms.tsx';
import { DisconnectConnectionDialog } from './DisconnectConnectionDialog.tsx';
import { RenameConnectionDialog } from './RenameConnectionDialog.tsx';
import { accountMeta, objState, pendingWords, rowAction, scopeList, serviceIcon, statusWords } from './ConnectionsScreen.logic.ts';

export function AccountRow({ connection, now }: { connection: ConnectionView; now: Date }) {
  const dispatch = useAppDispatch();
  const call = useAppSelector(s => selectConnectionCall(s, connection.id));
  const link = useAppSelector(s => selectConnectionLink(s, connection.id));
  const failure = useAppSelector(s => selectConnectionFailure(s, connection.id));
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<'rename' | 'disconnect' | null>(null);
  const busy = call !== null;
  const status = statusWords(connection.status);
  const action = rowAction(connection, link, now);
  const scopes = scopeList(connection.scope);
  const pending = pendingWords(connection, link, now);
  const reconnect = () => {
    if (!busy) {
      dispatch(reconnectConnection(connection.id));
    }
  };

  return (
    <>
      <Row
        lead={<Obj icon={serviceIcon(connection.server)} size="md" state={objState(connection.status)} />}
        title={connection.displayName}
        meta={accountMeta(connection, now)}
        desc={
          scopes.length > 0 || pending || failure ? (
            <>
              {scopes.length > 0 ? (
                <span className="conn-scopes">
                  {scopes.map(scope => (
                    <Code key={scope}>{scope}</Code>
                  ))}
                </span>
              ) : null}
              {pending ? <Quiet>{pending}</Quiet> : null}
              {failure ? <ErrorLine className="conn-fail">Sign-in failed: {failure.error}</ErrorLine> : null}
            </>
          ) : undefined
        }
        end={
          <>
            {action?.kind === 'open' ? <Btn label={action.label} icon="log-in" size="sm" href={action.url} external /> : null}
            {action?.kind === 'reconnect' ? <Btn label={action.label} icon="log-in" size="sm" busy={call?.kind === 'reconnect'} disabled={busy} onClick={reconnect} /> : null}
            <Badge state={status.state} label={status.label} />
            <MenuAnchor
              open={open}
              onClose={() => setOpen(false)}
              menu={
                <Menu label={`Actions of ${connection.displayName}`}>
                  <MenuItem
                    icon="pencil"
                    label="Rename…"
                    onClick={() => {
                      setOpen(false);
                      setDialog('rename');
                    }}
                  />
                  <MenuItem
                    icon="refresh-cw"
                    label={connection.status === 'connected' ? 'Reconnect' : 'Get a sign-in link'}
                    disabled={busy}
                    onClick={() => {
                      setOpen(false);
                      reconnect();
                    }}
                  />
                  <MenuItem
                    icon="unplug"
                    label="Disconnect…"
                    variant="danger"
                    disabled={busy}
                    onClick={() => {
                      setOpen(false);
                      setDialog('disconnect');
                    }}
                  />
                </Menu>
              }
            >
              <IconBtn icon="ellipsis" label="Rename, reconnect, disconnect" size="sm" expanded={open} onClick={() => setOpen(!open)} />
            </MenuAnchor>
          </>
        }
      />
      {dialog === 'rename' ? <RenameConnectionDialog connection={connection} onClose={() => setDialog(null)} /> : null}
      {dialog === 'disconnect' ? <DisconnectConnectionDialog connection={connection} onClose={() => setDialog(null)} /> : null}
    </>
  );
}
