// The page of the consent window (consent.ts; the design: "15 Browser
// extension · limits, consent, icon"): who asks — the workspace and the
// agent's thread — for which tab, what allowing means and how to take the
// tab back, the minute running out, Deny and Allow. Closing the window
// denies; a minute without an answer closes it. The title of the window
// names the site, so two windows are told apart in the list of windows.
// When the request ends under an open window — its session is over — the
// page says so and has nothing left to decide.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../console/styles/index.css';
import { Avatar } from '../console/ui/Avatar/Avatar.tsx';
import { Btn } from '../console/ui/Btn/Btn.tsx';
import { Icon } from '../console/ui/Icon/Icon.tsx';
import { Prog } from '../console/ui/Prog/Prog.tsx';
import '../console/ui/atoms/atoms.css';
import './pages.css';
import type { ConsentView } from './consent.ts';
import { addressParts, ask, tabLetter } from './pages.ts';
import { applyStoredTheme } from './theme.ts';

const POLL_MS = 500;
// The last seconds of the minute are shown in amber.
const LOW_SECONDS = 10;
const WIDTH = 400;

const id = new URLSearchParams(location.search).get('id') ?? '';

// The window as tall as what it shows.
async function fitWindow(): Promise<void> {
  const current = await chrome.windows.getCurrent();
  const width = WIDTH + (window.outerWidth - window.innerWidth);
  const height = document.body.offsetHeight + (window.outerHeight - window.innerHeight);

  if (current.id !== undefined && current.type === 'popup' && (current.width !== width || current.height !== height)) {
    await chrome.windows.update(current.id, { width, height });
  }
}

function Consent() {
  // undefined — not asked yet; null — the request is over.
  const [request, setRequest] = useState<ConsentView | null>();
  // What the window showed, for the page of a request that is over.
  const last = useRef<ConsentView | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const look = () =>
      void ask({ type: 'consent.get', id }).then(answer => {
        if (answer) {
          last.current = answer;
        }

        setRequest(answer ?? null);
        setNow(Date.now());
      });

    look();

    const timer = setInterval(look, POLL_MS);

    return () => clearInterval(timer);
  }, []);

  const shown = request ?? last.current;
  const over = request === null;
  const address = addressParts(shown?.url);

  useEffect(() => {
    document.title = !shown ? 'Balabash Agent' : over ? `Request over — ${address.host}` : `Give ${address.host} to an agent?`;
  }, [shown, over, address.host]);

  useLayoutEffect(() => {
    void fitWindow().catch(() => {});
  }, [request === undefined, over]);

  if (request === undefined) {
    return <div className="cw" aria-busy="true" />;
  }

  const answer = (allow: boolean) => void ask({ type: 'consent.answer', id, allow }).then(() => window.close());
  const left = shown ? Math.max(0, Math.ceil((shown.expiresAt - now) / 1000)) : 0;
  const share = shown ? Math.max(0, Math.min(100, ((shown.expiresAt - now) / (shown.expiresAt - shown.askedAt)) * 100)) : 0;
  const tab = shown ? (
    <div className="cw-tab">
      <span className="ext-fav" aria-hidden="true">
        {tabLetter(shown.title, shown.url)}
      </span>
      <span className="cw-tab-t" id="title">
        {shown.title || '(untitled)'}
      </span>
      <span className="cw-tab-u" id="url" title={shown.url}>
        <b>{address.host}</b>
        {address.path}
      </span>
    </div>
  ) : null;

  return (
    <div className="cw" data-low={!over && left <= LOW_SECONDS ? 'yes' : undefined} data-over={over ? 'yes' : undefined}>
      <div className="cw-b">
        {shown ? (
          <div className="cw-who">
            <Avatar agent="user_browser" size="sm" />
            <span id="label">
              {shown.workspace ? <b>{shown.workspace}</b> : null}
              {shown.workspace && shown.thread ? ' · ' : null}
              {shown.thread}
            </span>
          </div>
        ) : null}
        {over ? (
          <>
            <h2 className="cw-h">This request is over</h2>
            {tab}
            <p className="cw-over" id="gone">
              The session ended before you answered. Nothing to decide — the tab stays yours.
            </p>
            <Btn label="Close" block id="close" onClick={() => window.close()} />
          </>
        ) : (
          <>
            <h2 className="cw-h">An agent asks for this tab</h2>
            {tab}
            <ul className="cw-means">
              <li>
                <Icon name="eye" />
                <span>It reads the page and acts on it under your login while the tab is in its group.</span>
              </li>
              <li>
                <Icon name="undo-2" />
                <span>Take it back any time: drag the tab out of the group, or stop the session from the toolbar icon.</span>
              </li>
            </ul>
            <div className="cw-time">
              <Prog value={share} label="Time left to answer" />
              <span>{left} s left</span>
            </div>
            <div className="cw-acts">
              <Btn label="Deny" block id="decline" onClick={() => answer(false)} />
              <Btn label="Allow" variant="primary" block id="allow" onClick={() => answer(true)} />
            </div>
            <span className="caption">Closing this window denies. No answer in a minute — the window closes and the agent is told you didn’t answer.</span>
          </>
        )}
      </div>
    </div>
  );
}

void applyStoredTheme();
createRoot(document.getElementById('root')!).render(<Consent />);
