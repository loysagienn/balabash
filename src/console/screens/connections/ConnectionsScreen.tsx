// Connections — the accounts of external services and the catalog of what
// can be connected. The rows and the catalog are the snapshot and its tail
// (store/connections): a banner over the list for every account the
// provider rejects (with its "Sign in"), the "Accounts" card with a row per
// account (AccountRow: the action of the moment, the badge, the menu), the
// "Service catalog" card with a tile per service — how many accounts it
// has and "Connect" where it takes another (a service of one account, once
// connected, is re-authorized from its row). A failed first snapshot
// replaces the screen with the error and Retry.

import { useState } from 'react';
import type { ServiceView } from '../../../api/contract.ts';
import { useNow } from '../../lib/format/useNow.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { snapshotLoad } from '../../store/stream/actions.ts';
import { selectStream, snapshotStage } from '../../store/stream/selectors.ts';
import { selectConnectionCall, selectConnections, selectConnectionsNeedingAction, selectServices } from '../../store/connections/selectors.ts';
import { reconnectConnection } from '../../store/connections/actions.ts';
import { Shell } from '../../features/shell/Shell.tsx';
import { Card, CardBody, CardHead } from '../../ui/Card/Card.tsx';
import { Empty } from '../../ui/Empty/Empty.tsx';
import { Icon } from '../../ui/Icon/Icon.tsx';
import { List } from '../../ui/List/List.tsx';
import { Note } from '../../ui/Note/Note.tsx';
import { Obj } from '../../ui/Obj/Obj.tsx';
import { Tiles } from '../../ui/ProjectTile/ProjectTile.tsx';
import { Screen } from '../../ui/Screen/Screen.tsx';
import { SkelRow } from '../../ui/Skel/Skel.tsx';
import { AccountRow } from './AccountRow.tsx';
import { ConnectServiceDialog } from './ConnectServiceDialog.tsx';
import { accountsOf, canConnect, catalogCount, needsSignInWords, serviceIcon } from './ConnectionsScreen.logic.ts';
import './ConnectionsScreen.css';

const SKELETON = [[48, 70], [36, 62], [52, 68]];

export function ConnectionsScreen() {
  const dispatch = useAppDispatch();
  const stream = useAppSelector(selectStream);
  const connections = useAppSelector(selectConnections);
  const needing = useAppSelector(selectConnectionsNeedingAction);
  const services = useAppSelector(selectServices);
  const now = useNow();
  const stage = snapshotStage(stream);
  const [connecting, setConnecting] = useState<ServiceView | null>(null);

  let body;

  if (stage === 'failed') {
    body = (
      <Card narrow="bare">
        <Empty icon="cloud-off" state="err" title="Couldn’t load the connections" action="Retry" actionIcon="refresh-cw" onAction={() => dispatch(snapshotLoad())}>
          {stream.snapshot.error?.message}
        </Empty>
      </Card>
    );
  } else if (stage === 'loading') {
    body = (
      <Card narrow="bare">
        <CardHead title="Accounts" />
        <List narrow="tiles" busy>
          {SKELETON.map((w, i) => (
            <SkelRow key={i} widths={w} />
          ))}
        </List>
      </Card>
    );
  } else {
    body = (
      <>
        {needing.map(connection => (
          <NeedsSignIn key={connection.id} id={connection.id} words={needsSignInWords(connection)} />
        ))}
        <Card narrow="bare">
          <CardHead title="Accounts" count={connections.length} countState={needing.length > 0 ? 'act' : undefined} />
          {connections.length === 0 ? (
            <Empty icon="plug" title="No accounts yet">
              Connect a service from the catalog below — agents get its tools once you sign in.
            </Empty>
          ) : (
            <List narrow="tiles">
              {connections.map(connection => (
                <AccountRow key={connection.id} connection={connection} now={now} />
              ))}
            </List>
          )}
        </Card>
        <Card narrow="bare">
          <CardHead title="Service catalog" count={services.length} />
          <CardBody>
            {services.length === 0 ? (
              <Empty icon="plug" title="No connectable services">
                Services with per-user sign-in appear here when the installation declares them (mcp-servers with auth: user).
              </Empty>
            ) : (
              <Tiles min="210px">
                {services.map(service => {
                  const accounts = accountsOf(connections, service.name).length;
                  const connectable = canConnect(service, accounts);
                  const inner = (
                    <>
                      <Obj icon={serviceIcon(service.name)} size="md" />
                      <span className="tile-t">{service.name}</span>
                      {service.description ? (
                        <span className="tile-d" title={service.description}>
                          {service.description}
                        </span>
                      ) : null}
                      <span className="tile-f">
                        <span>{catalogCount(accounts)}</span>
                        {connectable ? (
                          <span className="link">
                            <Icon name="plus" />
                            Connect
                          </span>
                        ) : null}
                      </span>
                    </>
                  );

                  return connectable ? (
                    <button key={service.name} type="button" className="tile conn-tile" data-size="sm" onClick={() => setConnecting(service)}>
                      {inner}
                    </button>
                  ) : (
                    <div key={service.name} className="tile" data-size="sm">
                      {inner}
                    </div>
                  );
                })}
              </Tiles>
            )}
          </CardBody>
        </Card>
      </>
    );
  }

  return (
    <Shell current="connections" title="Connections">
      <Screen>{body}</Screen>
      {connecting ? <ConnectServiceDialog service={connecting} accounts={accountsOf(connections, connecting.name).length} onClose={() => setConnecting(null)} /> : null}
    </Shell>
  );
}

// The banner of an account the provider rejects: its "Sign in" asks for a
// link; the row below opens it once answered.
function NeedsSignIn({ id, words }: { id: string; words: string }) {
  const dispatch = useAppDispatch();
  const call = useAppSelector(s => selectConnectionCall(s, id));

  return (
    <Note state="act" icon="key-round" role="status" action="Sign in" actionIcon="log-in" actionBusy={call?.kind === 'reconnect'} onAction={() => (call ? undefined : dispatch(reconnectConnection(id)))}>
      {words}
    </Note>
  );
}
