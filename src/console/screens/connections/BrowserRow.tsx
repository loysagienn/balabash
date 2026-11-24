// A row of the Browsers card. A browser of the user: its name, "this
// browser", on the link or not, its extension — an amber line and "Update"
// when it is out of date — the switch that turns it on or off in this
// workspace at once (store/browsers: the outcome is a toast, a refusal puts
// the switch back) and the owner's menu: the name, the update, the
// disconnect for good — each a dialog. A row off in this workspace is
// dimmed. A browser of another member: whose it is and whether it is on the
// link, without commands.

import { useState } from 'react';
import type { BrowserView, OtherBrowserView } from '../../../api/contract.ts';
import { setBrowserHere } from '../../store/browsers/actions.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { Badge } from '../../ui/Badge/Badge.tsx';
import { Btn } from '../../ui/Btn/Btn.tsx';
import { Check } from '../../ui/Check/Check.tsx';
import { IconBtn } from '../../ui/IconBtn/IconBtn.tsx';
import { Row } from '../../ui/List/List.tsx';
import { Menu, MenuAnchor, MenuItem, MenuSep } from '../../ui/Menu/Menu.tsx';
import { Obj } from '../../ui/Obj/Obj.tsx';
import { Presence } from '../../ui/Overlay/presence.tsx';
import { Tag } from '../../ui/atoms/atoms.tsx';
import { DisconnectBrowserDialog } from './DisconnectBrowserDialog.tsx';
import { RenameBrowserDialog } from './RenameBrowserDialog.tsx';
import { UpdateExtensionDialog } from './UpdateExtensionDialog.tsx';
import { browserBadge, browserMeta, otherWords, outdatedLine } from './Browsers.logic.ts';

export type BrowserRowProps = {
  browser: BrowserView;
  // The browser the console is open in, and whether its extension is on pause.
  here: boolean;
  pausedHere: boolean;
  // The version of the extension the installation hands out.
  current: string | null;
  workspace: string;
  fresh: boolean;
  now: Date;
};

export function BrowserRow({ browser, here, pausedHere, current, workspace, fresh, now }: BrowserRowProps) {
  const dispatch = useAppDispatch();
  const switching = useAppSelector(state => state.browsers.switching[browser.id]);
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<'rename' | 'update' | 'disconnect' | null>(null);
  // The switch shows where the user put it until the list says the same.
  const on = switching ? switching.on : browser.enabledHere;
  const badge = browserBadge(browser.online, here && pausedHere);
  const outdated = outdatedLine(browser, here, current);
  const pick = (next: 'rename' | 'update' | 'disconnect') => () => {
    setOpen(false);
    setDialog(next);
  };

  return (
    <>
      <Row
        lead={<Obj icon="app-window" size="md" />}
        title={browser.name}
        tag={here ? <Tag>this browser</Tag> : null}
        meta={browserMeta(browser, { here, on, workspace, now })}
        note={outdated ? <span className="row-m brw-upd">{outdated}</span> : null}
        dim={!on}
        fresh={fresh}
        end={
          <>
            {outdated ? <Btn label="Update" icon="download" size="sm" className="brw-upd-b" onClick={pick('update')} /> : null}
            <Badge state={badge.state} label={badge.label} />
            <Check kind="switch" label={`In ${workspace}`} checked={on} disabled={Boolean(switching && !switching.settled)} onChange={next => dispatch(setBrowserHere(browser.id, browser.name, next))} />
            <MenuAnchor
              open={open}
              onClose={() => setOpen(false)}
              menu={
                <Menu label={`Actions of ${browser.name}`}>
                  <MenuItem icon="pencil" label="Rename…" onClick={pick('rename')} />
                  {outdated ? <MenuItem icon="download" label="Update the extension…" onClick={pick('update')} /> : null}
                  <MenuSep />
                  <MenuItem icon="unplug" label="Disconnect…" variant="danger" onClick={pick('disconnect')} />
                </Menu>
              }
            >
              <IconBtn icon="ellipsis" label={outdated ? 'Rename, update, disconnect' : 'Rename, disconnect'} size="sm" expanded={open} onClick={() => setOpen(!open)} />
            </MenuAnchor>
          </>
        }
      />
      <Presence>{dialog === 'rename' ? <RenameBrowserDialog browser={browser} onClose={() => setDialog(null)} /> : null}</Presence>
      <Presence>{dialog === 'update' && current ? <UpdateExtensionDialog browser={browser} here={here} current={current} onClose={() => setDialog(null)} /> : null}</Presence>
      <Presence>{dialog === 'disconnect' ? <DisconnectBrowserDialog browser={browser} onClose={() => setDialog(null)} /> : null}</Presence>
    </>
  );
}

export function OtherBrowserRow({ browser, fresh, now }: { browser: OtherBrowserView; fresh: boolean; now: Date }) {
  const badge = browserBadge(browser.online);
  const words = otherWords(browser, now);

  return <Row lead={<Obj icon="app-window" size="md" />} title={words.title} meta={words.meta} fresh={fresh} end={<Badge state={badge.state} label={badge.label} />} />;
}
