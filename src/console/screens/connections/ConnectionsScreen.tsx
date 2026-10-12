// Connections — the accounts of external services and the catalog of what
// can be connected. The rows and the catalog are the snapshot and its tail
// (store/connections): a banner over the list for every account the
// provider rejects (with its "Sign in"), the "Accounts" card with a row per
// account (AccountRow: the action of the moment, the badge, the menu), the
// "Service catalog" card with a tile per service, by name: a service of
// per-user accounts — how many accounts it has and "Connect" where it
// takes another (a service of one account, once connected, is
// re-authorized from its row); a service of the installation (one set of
// credentials for every workspace, the second data layer — queries.ts) —
// its state and "Set up" / "Manage", which open InstallationServiceDialog;
// a claude.ai connector of the installation — read-only, its state and
// "Details" (ConnectorServiceDialog).
// A failed first snapshot replaces the screen with the error and Retry; a
// failed read of the installation's services is a note in the catalog (a
// 404 — the server of an older build — is no services, quietly).

import { useState } from 'react';
import type { ConnectorServiceView, InstallationServiceView, ServiceView } from '../../../api/contract.ts';
import { toApiFailure } from '../../lib/api/index.ts';
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
import { ConnectorServiceDialog } from './ConnectorServiceDialog.tsx';
import { InstallationServiceDialog } from './InstallationServiceDialog.tsx';
import { accountsOf, canConnect, catalogCount, catalogEntries, connectorWords, installationWords, needsSignInWords, serviceIcon } from './ConnectionsScreen.logic.ts';
import { useInstallationServices } from './queries.ts';
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
  const installation = useInstallationServices();
  const [managing, setManaging] = useState<InstallationServiceView | null>(null);
  const [inspecting, setInspecting] = useState<ConnectorServiceView | null>(null);
  const entries = catalogEntries(services, installation.data?.services ?? [], installation.data?.connectors ?? []);
  // The server of an older build has no such route (404) until the app
  // restarts: the catalog shows the per-user services alone, quietly.
  const olderServer = installation.isError && toApiFailure(installation.error).status === 404;

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
          <CardHead title="Service catalog" count={entries.length} />
          <CardBody>
            {installation.isError && !olderServer ? (
              <Note state="err" icon="cloud-off" role="alert" action="Retry" actionIcon="refresh-cw" actionBusy={installation.isFetching} onAction={() => void installation.refetch()}>
                Couldn’t load the services of the installation. {installation.error.message}
              </Note>
            ) : null}
            {entries.length === 0 ? (
              installation.isPending ? null : (
                <Empty icon="plug" title="No services">
                  Services appear here when the installation declares them in mcp-servers: per-user sign-in (auth: user), installation credentials (secret:NAME) or a claude.ai connector (claude-connector).
                </Empty>
              )
            ) : (
              <Tiles min="210px" className="conn-cat">
                {entries.map(entry => {
                  if (entry.kind === 'connector') {
                    const service = entry.service;
                    const words = connectorWords(service);

                    return (
                      <button key={service.name} type="button" className="tile conn-tile" data-size="sm" onClick={() => setInspecting(service)}>
                        <Obj icon={serviceIcon(service.name)} size="md" state={words.state} />
                        <span className="tile-t">{service.name}</span>
                        {service.description ? (
                          <span className="tile-d" title={service.description}>
                            {service.description}
                          </span>
                        ) : null}
                        <span className="tile-f">
                          <span>{words.label}</span>
                          <span className="link">
                            <Icon name="info" />
                            Details
                          </span>
                        </span>
                      </button>
                    );
                  }

                  if (entry.kind === 'installation') {
                    const service = entry.service;
                    const words = installationWords(service);

                    return (
                      <button key={service.name} type="button" className="tile conn-tile" data-size="sm" onClick={() => setManaging(service)}>
                        <Obj icon={serviceIcon(service.name)} size="md" state={words.state} />
                        <span className="tile-t">{service.name}</span>
                        {service.description ? (
                          <span className="tile-d" title={service.description}>
                            {service.description}
                          </span>
                        ) : null}
                        <span className="tile-f">
                          <span>{words.label}</span>
                          <span className="link">
                            <Icon name={service.state === 'missing' ? 'key-round' : 'sliders-horizontal'} />
                            {words.link}
                          </span>
                        </span>
                      </button>
                    );
                  }

                  const service = entry.service;
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
      {managing ? <InstallationServiceDialog service={managing} onClose={() => setManaging(null)} /> : null}
      {inspecting ? <ConnectorServiceDialog service={inspecting} onClose={() => setInspecting(null)} /> : null}
    </Shell>
  );
}

// The banner of an account the provider rejects: its "Sign in again" asks for a
// link; the row below opens it once answered.
function NeedsSignIn({ id, words }: { id: string; words: string }) {
  const dispatch = useAppDispatch();
  const call = useAppSelector(s => selectConnectionCall(s, id));

  return (
    <Note state="act" icon="key-round" role="status" action="Sign in again" actionBusy={call?.kind === 'reconnect'} onAction={() => (call ? undefined : dispatch(reconnectConnection(id)))}>
      {words}
    </Note>
  );
}
