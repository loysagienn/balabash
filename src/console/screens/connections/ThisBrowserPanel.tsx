// The panel on top of the Browsers card: the browser the console is open
// in — its state and the next step (Browsers.logic.ts: herePanel). None
// when all is well; over any state with the extension installed — the
// amber panel of an extension that is out of date.
//
// Connecting is a form in the panel itself: the user names the browser, the
// server issues a one-time code for that name (POST /api/browsers/pairings),
// the page hands the code to the extension (lib/extension), and the
// extension dials the server with it — from then on the browser is the
// user's, on in this workspace. A refusal of the name shows under the
// field; a pairing that did not happen — as a note under the form, which
// stays for another try.

import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { BrowsersResponse } from '../../../api/contract.ts';
import { useCopy } from '../../features/clipboard/useCopy.ts';
import { extensionArchiveUrl, toApiFailure } from '../../lib/api/index.ts';
import { useApi } from '../../lib/api/context.tsx';
import { canReachExtension, pairExtension } from '../../lib/extension/index.ts';
import type { ExtensionPresence } from '../../lib/extension/index.ts';
import { BROWSERS_KEY } from '../../lib/query/browsers.ts';
import { setBrowserHere } from '../../store/browsers/actions.ts';
import { pairedWords } from '../../store/browsers/words.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { pushToast } from '../../store/ui/actions.ts';
import { Btn } from '../../ui/Btn/Btn.tsx';
import { Field } from '../../ui/Field/Field.tsx';
import { Icon } from '../../ui/Icon/Icon.tsx';
import type { IconName } from '../../ui/Icon/Icon.tsx';
import { Input } from '../../ui/Input/Input.tsx';
import { Note } from '../../ui/Note/Note.tsx';
import { Obj } from '../../ui/Obj/Obj.tsx';
import { SkelStack } from '../../ui/Skel/Skel.tsx';
import { Code, Quiet } from '../../ui/atoms/atoms.tsx';
import { BROWSER_NAME_MAX_LENGTH, archiveLabel, defaultBrowserName, extensionUpdate, herePanel, nameError, nameRefusal, pairErrorWords, pairingRefusedWords } from './Browsers.logic.ts';

const EXTENSIONS_ADDRESS = 'chrome://extensions';
const NAME_ID = 'connect-browser-name';
// A pairing that went through keeps the form busy until the panel leaves
// with the list read again; if it does not, the form is given back.
const PAIRED_HOLD_MS = 5000;

type HereProps = {
  icon: IconName;
  state?: 'act' | 'wait';
  tone?: 'quiet';
  panelState?: 'act';
  busy?: boolean;
  title: ReactNode;
  desc: ReactNode;
  children?: ReactNode;
};

function Here({ icon, state, tone, panelState, busy, title, desc, children }: HereProps) {
  return (
    <div className="brw-here" data-state={panelState} data-tone={tone} aria-busy={busy ? 'true' : undefined}>
      <Obj icon={icon} size="md" state={state} />
      <div>
        <div className="brw-here-t">{title}</div>
        <p className="brw-here-d">{desc}</p>
      </div>
      {children ? <div className="brw-here-b">{children}</div> : null}
    </div>
  );
}

// "Copy address": Chrome opens chrome://extensions from the address bar
// only, a link to it does nothing.
function CopyAddress() {
  const copy = useCopy();

  return <Btn label="Copy address" icon="copy" size="sm" onClick={() => void copy(EXTENSIONS_ADDRESS, { done: 'Address copied', fail: 'Couldn’t copy the address' })} />;
}

// What connecting means, in three points.
function Means({ workspace }: { workspace: string }) {
  return (
    <ul className="brw-means">
      <li>
        <Icon name="key-round" />
        <span>
          <b>Under your logins</b>Agents open tabs and act on the sites you’re signed in to.
        </span>
      </li>
      <li>
        <Icon name="users" />
        <span>
          <b>For any member</b>Anyone in {workspace} can give an agent work in this browser.
        </span>
      </li>
      <li>
        <Icon name="shield" />
        <span>
          <b>Your limits</b>Blocked sites, asking before a tab, pause and stop — from the extension icon.
        </span>
      </li>
    </ul>
  );
}

// The name and "Connect this browser". `onTooOld` — the extension turned
// out too old for the server: the panel above offers the new one.
function PairForm({ extensionId, workspace, onTooOld }: { extensionId: string; workspace: string; onTooOld: () => void }) {
  const api = useApi();
  const dispatch = useAppDispatch();
  const queryClient = useQueryClient();
  const [name, setName] = useState(() => defaultBrowserName(navigator.userAgent));
  const [busy, setBusy] = useState(false);
  // What is wrong with the name, and why a pairing did not happen.
  const [refusal, setRefusal] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const held = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(held.current), []);

  const connect = async (): Promise<boolean> => {
    const clean = name.trim();
    let code: string;

    try {
      ({ code } = await api.browsers.requestPairing(clean));
    } catch (error) {
      const refused = toApiFailure(error);
      const ofName = nameRefusal(clean, refused);

      if (ofName) {
        setRefusal(ofName);
      } else {
        setFailure(pairingRefusedWords(refused));
      }

      return false;
    }

    const result = await pairExtension(extensionId, code);

    if (!result.ok) {
      setFailure(pairErrorWords(result.error));

      if (result.error === 'unsupported_protocol') {
        onTooOld();
      }

      return false;
    }

    dispatch(pushToast(pairedWords(clean, workspace)));
    await queryClient.invalidateQueries({ queryKey: BROWSERS_KEY });

    return true;
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (busy) {
      return;
    }

    const wrong = nameError(name);

    setRefusal(wrong);
    setFailure(null);

    if (wrong) {
      return;
    }

    setBusy(true);
    void connect().then(
      paired => {
        if (paired) {
          held.current = window.setTimeout(() => setBusy(false), PAIRED_HOLD_MS);
        } else {
          setBusy(false);
        }
      },
      () => setBusy(false),
    );
  };

  return (
    <>
      <form className="brw-pair" onSubmit={submit} noValidate>
        <Field label="Browser name" fid={NAME_ID} hint={`Up to 60 characters. You and the members of ${workspace} see it; you can rename it later.`} err={refusal} required>
          <Input
            id={NAME_ID}
            name="name"
            value={name}
            onChange={value => {
              setName(value);
              setRefusal(null);
            }}
            maxLength={BROWSER_NAME_MAX_LENGTH}
            autoComplete="off"
            invalid={Boolean(refusal)}
          />
        </Field>
        <Btn type="submit" label={busy ? 'Connecting…' : 'Connect this browser'} icon="plug" variant="primary" busy={busy} />
      </form>
      {failure ? (
        <Note state="err" icon="circle-x" role="alert">
          {failure}
        </Note>
      ) : null}
    </>
  );
}

// The extension has not answered yet — or the list it is judged against is
// still being read.
export function CheckingPanel() {
  return (
    <Here icon="puzzle" busy title="This browser" desc="Looking for the Balabash Agent extension here…">
      <SkelStack widths={[44, 30]} />
    </Here>
  );
}

export function ThisBrowserPanel({ listing, presence, workspace, recheck }: { listing: BrowsersResponse; presence: ExtensionPresence | null; workspace: string; recheck: () => void }) {
  const dispatch = useAppDispatch();
  const switching = useAppSelector(state => state.browsers.switching);
  // The extension said the server does not speak its wire any more.
  const [tooOld, setTooOld] = useState(false);
  const panel = herePanel(presence, listing);
  const update = extensionUpdate(presence, listing);
  const current = listing.extension.version;
  const download = extensionArchiveUrl();
  // A page that was open when the extension was installed gets no way to
  // talk to it until it is loaded again.
  const checkAgain = () => (canReachExtension() ? recheck() : window.location.reload());
  let body: ReactNode = null;

  switch (panel.kind) {
    case 'checking':
      body = <CheckingPanel />;
      break;
    case 'not-chrome':
      body = (
        <Here
          icon="monitor-smartphone"
          tone="quiet"
          title="Connect from Chrome on a computer"
          desc="This page is open in another browser. A browser is connected from itself: open Connections in the desktop Chrome you want agents to work in."
        />
      );
      break;
    case 'no-build':
      body = (
        <Here
          icon="package-x"
          state="act"
          title="No extension to install"
          desc={
            <>
              This installation hasn’t built the Balabash Agent extension, so there is nothing to download. It is built on the server with <Code>CONSOLE_DOMAIN</Code> set: <Code>npm run build-extension</Code>.
            </>
          }
        />
      );
      break;
    case 'no-ext':
      body = (
        <Here
          icon="puzzle"
          title="Connect this browser"
          desc={`Agents of ${workspace} will work in this Chrome under your logins, whenever any member of the workspace asks. You keep the limits in the extension itself.`}
        >
          <Means workspace={workspace} />
          <ol className="brw-steps">
            <li>
              <span>
                <b>Download the extension.</b> <Quiet>{archiveLabel(listing.extension)}</Quiet>
                <span className="brw-acts">
                  <Btn label="Download extension" icon="download" variant="primary" size="sm" href={download} />
                </span>
              </span>
            </li>
            <li>
              <span>
                <b>Unzip it into a folder you’ll keep.</b> <Quiet>Chrome loads the extension from that folder, so don’t move or delete it later.</Quiet>
              </span>
            </li>
            <li>
              <span>
                <b>Load it in Chrome.</b>{' '}
                <Quiet>
                  Open <Code>{EXTENSIONS_ADDRESS}</Code>, turn on Developer mode, click Load unpacked and pick the folder.
                </Quiet>
                <span className="brw-acts">
                  <CopyAddress />
                </span>
              </span>
            </li>
            <li>
              <span>
                <b>Come back here.</b> <Quiet>This page finds the extension and asks for a name for this browser.</Quiet>
                <span className="brw-acts">
                  <Btn label="Check again" icon="refresh-cw" size="sm" onClick={checkAgain} />
                </span>
              </span>
            </li>
          </ol>
        </Here>
      );
      break;
    case 'unpaired':
      body = (
        <Here
          icon="puzzle"
          title="Connect this browser"
          desc={`Balabash Agent ${panel.version} is installed here. Name this browser and connect it: agents of ${workspace} will work in it under your logins, whenever any member asks.`}
        >
          <Means workspace={workspace} />
          <PairForm extensionId={listing.extension.id} workspace={workspace} onTooOld={() => setTooOld(true)} />
        </Here>
      );
      break;
    case 'off-here': {
      const { browser } = panel;
      const turning = switching[browser.id];

      body = (
        <Here
          icon="plug-zap"
          state="wait"
          title={`“${browser.name}” is off in ${workspace}`}
          desc={`This browser is connected to you, but agents of ${workspace} can’t use it. Turned on, they work here under your logins whenever any member asks.`}
        >
          <span className="brw-acts">
            <Btn label={`Turn on in ${workspace}`} icon="power" variant="primary" size="sm" busy={Boolean(turning)} onClick={() => dispatch(setBrowserHere(browser.id, browser.name, true))} />
          </span>
        </Here>
      );
      break;
    }
    case 'paused':
      body = (
        <Here
          icon="pause"
          state="wait"
          title={`“${panel.browser.name}” is paused`}
          desc="The extension isn’t keeping its link to the server, so no agent can reach this browser. Resume it from the Balabash Agent icon in the Chrome toolbar."
        />
      );
      break;
  }

  // Over any state with the extension installed; a pairing the server
  // refused as too old brings the panel even before the versions say so.
  const outdated = presence?.kind === 'present' && current && (update || tooOld);

  return (
    <>
      {outdated ? (
        <Here
          icon="circle-arrow-up"
          state="act"
          panelState="act"
          title="The extension in this browser is out of date"
          desc={
            <>
              {update ? `${update.installed} here, ${update.current} on the server. ` : null}Download the new one, unzip it over the old folder — the same place, so Chrome finds it — and press Reload on Balabash Agent in <Code>{EXTENSIONS_ADDRESS}</Code>. Its connection and settings stay.
            </>
          }
        >
          <span className="brw-acts">
            <Btn label={`Download ${current}`} icon="download" variant="primary" size="sm" href={download} />
            <CopyAddress />
            <Btn label="Check again" icon="refresh-cw" size="sm" onClick={checkAgain} />
          </span>
        </Here>
      ) : null}
      {body}
    </>
  );
}
