// "Browsers" of the Connections screen: the browsers users linked through
// the Balabash Agent extension (src/browser-link) — one card. On top, the
// browser the console is open in: its state and the next step
// (ThisBrowserPanel), by what the extension there answers (lib/extension)
// and what the server lists; no panel when all is well — the row says
// "this browser". Under it the user's own browsers, all of them — each
// switched on or off in this workspace, renamed, updated and disconnected
// by its owner (BrowserRow) — and the browsers of other members that are on
// in the workspace, without commands.
//
// The list is data of the second layer (queries.ts): who is connected is
// the server's memory, re-read on the stream's `browsers` frame. The
// extension is asked again with every re-read — a pairing or a pause
// changes its answer. A row that came or changed between two reads flashes.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrowsersResponse } from '../../../api/contract.ts';
import { toApiFailure } from '../../lib/api/index.ts';
import { extensionPresence, supportsExtension } from '../../lib/extension/index.ts';
import type { ExtensionPresence } from '../../lib/extension/index.ts';
import { browsersRead } from '../../store/browsers/actions.ts';
import { hereName } from '../../store/browsers/words.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { selectMe } from '../../store/session/selectors.ts';
import { Card, CardHead } from '../../ui/Card/Card.tsx';
import { Empty } from '../../ui/Empty/Empty.tsx';
import { List } from '../../ui/List/List.tsx';
import { SkelRow } from '../../ui/Skel/Skel.tsx';
import { Quiet } from '../../ui/atoms/atoms.tsx';
import { BrowserRow, OtherBrowserRow } from './BrowserRow.tsx';
import { CheckingPanel, ThisBrowserPanel } from './ThisBrowserPanel.tsx';
import { changedRows, isPausedHere, loadFailedWords, rowSignatures, thisBrowser } from './Browsers.logic.ts';
import { useBrowsers } from './queries.ts';

const SKELETON: [number, number][] = [
  [34, 22],
  [28, 40],
  [38, 26],
];
// As long as the flash of a row runs (tokens: --flash).
const FLASH_MS = 2400;
const NO_ROWS: ReadonlySet<string> = new Set();

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

// The rows that came or changed with the last read of the list, for the
// time their flash runs; none at the first read.
function useFreshRows(listing: BrowsersResponse | undefined): ReadonlySet<string> {
  const known = useRef<Map<string, string> | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [fresh, setFresh] = useState(NO_ROWS);

  useEffect(() => {
    if (!listing) {
      return;
    }

    const now = rowSignatures(listing);
    const changed = changedRows(known.current, now);

    known.current = now;

    if (changed.length > 0) {
      window.clearTimeout(timer.current);
      setFresh(new Set(changed));
      timer.current = window.setTimeout(() => setFresh(NO_ROWS), FLASH_MS);
    }
  }, [listing]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return fresh;
}

export function BrowsersSection({ now }: { now: Date }) {
  const dispatch = useAppDispatch();
  const browsers = useBrowsers();
  const workspace = hereName(useAppSelector(selectMe)?.workspaceName);
  const { presence, recheck } = useExtensionPresence(browsers.data?.extension.id, browsers.dataUpdatedAt);
  const fresh = useFreshRows(browsers.data);

  // A list read after the switches settled says what they said (store/browsers).
  useEffect(() => {
    if (browsers.dataUpdatedAt) {
      dispatch(browsersRead());
    }
  }, [dispatch, browsers.dataUpdatedAt]);

  // The server of an older build has no such route (404) until the app
  // restarts: no section, quietly.
  if (browsers.isError && toApiFailure(browsers.error).status === 404) {
    return null;
  }

  if (browsers.isError && !browsers.data) {
    return (
      <Card narrow="bare">
        <CardHead title="Browsers" />
        <Empty icon="circle-x" state="err" title="Couldn’t load browsers" action="Try again" actionIcon="refresh-cw" onAction={() => void browsers.refetch()}>
          {loadFailedWords(toApiFailure(browsers.error))}
        </Empty>
      </Card>
    );
  }

  if (!browsers.data) {
    return (
      <Card narrow="bare">
        <CardHead title="Browsers" />
        {supportsExtension(window) ? <CheckingPanel /> : null}
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
  const pausedHere = isPausedHere(presence);
  const count = listing.browsers.length + listing.others.length;

  return (
    <Card narrow="bare">
      <CardHead title="Browsers" count={count} />
      <ThisBrowserPanel listing={listing} presence={presence} workspace={workspace} recheck={recheck} />
      {count === 0 ? (
        <Empty icon="app-window" title="No browsers yet">
          No one has connected a browser to {workspace}. Connect this one above, and agents of {workspace} can work in it.
        </Empty>
      ) : (
        <>
          <div className="brw-sub">Yours · {listing.browsers.length}</div>
          {listing.browsers.length === 0 ? <p className="brw-none">You haven’t connected a browser. Connect one from the Chrome it runs in.</p> : null}
          <List narrow="tiles">
            {listing.browsers.map(browser => (
              <BrowserRow
                key={browser.id}
                browser={browser}
                here={browser.id === mine?.id}
                pausedHere={pausedHere}
                current={listing.extension.version}
                workspace={workspace}
                fresh={fresh.has(browser.id)}
                now={now}
              />
            ))}
          </List>
          {listing.others.length > 0 ? (
            <>
              <div className="brw-sub">
                Other members’ browsers enabled in {workspace} · {listing.others.length} — <Quiet>agents can work in them too; only their owners manage them</Quiet>
              </div>
              <List narrow="tiles">
                {listing.others.map(browser => (
                  <OtherBrowserRow key={browser.id} browser={browser} fresh={fresh.has(browser.id)} now={now} />
                ))}
              </List>
            </>
          ) : null}
        </>
      )}
    </Card>
  );
}
