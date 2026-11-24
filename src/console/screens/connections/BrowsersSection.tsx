// "Browsers" of the Connections screen: the browsers users linked through
// the Balabash Agent extension (src/browser-link). The section shows the
// user's own browsers — each renamed, enabled or disabled in this workspace
// and disconnected by its owner — and the browsers of others enabled in the
// workspace, and above them what can be done about the browser the console
// is open in: by what the extension there answers (lib/extension) and what
// the server lists (Browsers.logic.ts) — install the extension, connect
// this browser, enable it here, update the extension.
//
// The list is data of the second layer (queries.ts): who is connected is
// the server's memory, re-read on the stream's `browsers` frame. The
// extension is asked again with every re-read — a pairing or a pause
// changes its answer.

import { useCallback, useEffect, useState } from 'react';
import type { BrowsersResponse, OtherBrowserView } from '../../../api/contract.ts';
import { extensionArchiveUrl, toApiFailure } from '../../lib/api/index.ts';
import { useApi } from '../../lib/api/context.tsx';
import { extensionPresence } from '../../lib/extension/index.ts';
import type { ExtensionPresence } from '../../lib/extension/index.ts';
import { useQueryClient } from '@tanstack/react-query';
import { BROWSERS_KEY } from '../../lib/query/browsers.ts';
import { useAppDispatch } from '../../store/hooks.ts';
import { pushToast } from '../../store/ui/actions.ts';
import { Badge } from '../../ui/Badge/Badge.tsx';
import { Btn } from '../../ui/Btn/Btn.tsx';
import { Card, CardBody, CardHead } from '../../ui/Card/Card.tsx';
import { Empty } from '../../ui/Empty/Empty.tsx';
import { List, Row } from '../../ui/List/List.tsx';
import { Note } from '../../ui/Note/Note.tsx';
import { Obj } from '../../ui/Obj/Obj.tsx';
import { Presence } from '../../ui/Overlay/presence.tsx';
import { SkelRow } from '../../ui/Skel/Skel.tsx';
import { BrowserRow } from './BrowserRow.tsx';
import { ConnectBrowserDialog } from './ConnectBrowserDialog.tsx';
import { browserStatusWords, extensionUpdate, thisBrowser, thisBrowserOffer } from './Browsers.logic.ts';
import { useBrowsers } from './queries.ts';

const SKELETON: [number, number][] = [
  [44, 66],
  [38, 58],
];

// What the extension of this browser says, asked again whenever `stamp`
// moves; null until the first answer.
function useExtensionPresence(extensionId: string | undefined, stamp: number): { presence: ExtensionPresence | null; recheck: () => void } {
  const [presence, setPresence] = useState<ExtensionPresence | null>(null);
  const [asked, setAsked] = useState(0);

  useEffect(() => {
    if (!extensionId) {
      return;
    }

    let current = true;

    void extensionPresence(extensionId).then(answer => {
      if (current) {
        setPresence(answer);
      }
    });

    return () => {
      current = false;
    };
  }, [extensionId, stamp, asked]);

  return { presence, recheck: useCallback(() => setAsked(count => count + 1), []) };
}

function OtherRow({ browser }: { browser: OtherBrowserView }) {
  const status = browserStatusWords(browser.online);

  return (
    <Row
      lead={<Obj icon="monitor" size="md" />}
      title={browser.name}
      meta={browser.ownerName ? `of ${browser.ownerName}` : 'of another user'}
      end={<Badge state={status.state} label={status.label} />}
    />
  );
}

// What can be done about the browser the console is open in.
function ThisBrowser({ listing, presence, recheck }: { listing: BrowsersResponse; presence: ExtensionPresence | null; recheck: () => void }) {
  const api = useApi();
  const dispatch = useAppDispatch();
  const queryClient = useQueryClient();
  const [connecting, setConnecting] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const offer = thisBrowserOffer(presence, listing);
  const update = extensionUpdate(presence, listing);
  const download = extensionArchiveUrl();

  const enable = (id: string, name: string) => {
    setEnabling(true);
    api.browsers
      .enableHere(id)
      .then(
        () => dispatch(pushToast({ title: `“${name}” is enabled in this workspace`, state: 'done' })),
        error => dispatch(pushToast({ title: `Couldn’t enable “${name}” here`, desc: toApiFailure(error).message, state: 'err' })),
      )
      .finally(() => {
        setEnabling(false);
        void queryClient.invalidateQueries({ queryKey: BROWSERS_KEY });
      });
  };

  let body = null;

  switch (offer.kind) {
    case 'unsupported':
      body = <Note icon="monitor">To connect a browser, open this console in the desktop Chrome you want to connect.</Note>;
      break;
    case 'not-built':
      body = (
        <Note state="off" icon="info">
          This installation has not built the Balabash Agent extension, so there is nothing to install yet.
        </Note>
      );
      break;
    case 'install':
      body = (
        <div className="conn-offer">
          <p>To let agents work in this browser, install the Balabash Agent extension:</p>
          <ol className="conn-steps">
            <li>Download the archive and unpack it — you get the folder “balabash-agent”. Keep it where it will stay: Chrome loads the extension from it.</li>
            <li>Open chrome://extensions, turn on “Developer mode”, press “Load unpacked” and choose that folder.</li>
            <li>Reload this page and press “Connect this browser”.</li>
          </ol>
          <div className="conn-offer-actions">
            <Btn label="Download the extension" icon="download" variant="primary" href={download} />
            <Btn label="Check again" icon="refresh-cw" variant="ghost" onClick={recheck} />
          </div>
        </div>
      );
      break;
    case 'connect':
      body = (
        <div className="conn-offer">
          <p>The Balabash Agent extension is installed in this browser and not connected to your account yet.</p>
          <Btn label="Connect this browser" icon="plug" variant="primary" onClick={() => setConnecting(true)} />
        </div>
      );
      break;
    case 'enable':
      body = (
        <Note icon="monitor" action="Enable here" actionIcon="link" actionBusy={enabling} onAction={() => enable(offer.browser.id, offer.browser.name)}>
          This browser is connected as “{offer.browser.name}”, but not enabled in this workspace: its agents cannot use it.
        </Note>
      );
      break;
    case 'paused':
      body = (
        <Note state="wait" icon="info">
          The extension in this browser is paused, so “{offer.browser.name}” is offline. Unpause it in the extension’s options — its button on Chrome’s toolbar.
        </Note>
      );
      break;
  }

  return (
    <>
      {body || update ? (
        <CardBody>
          {update ? (
            <div className="conn-offer">
              <Note state="act" icon="download">
                The extension in this browser is {update.installed}; the current one is {update.current}. Download the archive, unpack it over the same folder and press the reload button on the extension’s card at chrome://extensions.
              </Note>
              <Btn label="Download the new extension" icon="download" size="sm" href={download} />
            </div>
          ) : null}
          {body}
        </CardBody>
      ) : null}
      <Presence>
        {connecting ? (
          <ConnectBrowserDialog
            extensionId={listing.extension.id}
            onClose={() => {
              setConnecting(false);
              recheck();
            }}
          />
        ) : null}
      </Presence>
    </>
  );
}

export function BrowsersSection({ now }: { now: Date }) {
  const browsers = useBrowsers();
  const { presence, recheck } = useExtensionPresence(browsers.data?.extension.id, browsers.dataUpdatedAt);

  // The server of an older build has no such route (404) until the app
  // restarts: no section, quietly.
  if (browsers.isError && toApiFailure(browsers.error).status === 404) {
    return null;
  }

  if (browsers.isError && !browsers.data) {
    return (
      <Card narrow="bare">
        <CardHead title="Browsers" />
        <CardBody>
          <Note state="err" icon="cloud-off" role="alert" action="Retry" actionIcon="refresh-cw" actionBusy={browsers.isFetching} onAction={() => void browsers.refetch()}>
            Couldn’t load the browsers. {browsers.error.message}
          </Note>
        </CardBody>
      </Card>
    );
  }

  if (!browsers.data) {
    return (
      <Card narrow="bare">
        <CardHead title="Browsers" />
        <List narrow="tiles" busy>
          {SKELETON.map((widths, index) => (
            <SkelRow key={index} widths={widths} />
          ))}
        </List>
      </Card>
    );
  }

  const listing = browsers.data;
  const mine = thisBrowser(presence, listing);
  const count = listing.browsers.length + listing.others.length;

  return (
    <Card narrow="bare">
      <CardHead title="Browsers" count={count} />
      <ThisBrowser listing={listing} presence={presence} recheck={recheck} />
      {count === 0 ? (
        <Empty icon="monitor" title="No browsers yet">
          A connected browser lets an agent open pages and act in them under your own logins — in tabs of its own, with a bar in Chrome while it works.
        </Empty>
      ) : (
        <List narrow="tiles">
          {listing.browsers.map(browser => (
            <BrowserRow key={browser.id} browser={browser} isThisBrowser={browser.id === mine?.id} now={now} />
          ))}
          {listing.others.map(browser => (
            <OtherRow key={browser.id} browser={browser} />
          ))}
        </List>
      )}
    </Card>
  );
}
