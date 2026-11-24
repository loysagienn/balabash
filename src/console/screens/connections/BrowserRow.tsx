// A row of "Browsers": one browser of the user. The owner's commands are in
// the row's menu — the name, enabled in this workspace or not, disconnected
// for good (with a confirmation) — each a call of /api/browsers whose
// outcome is a toast; the list is read again after it.

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { BrowserView } from '../../../api/contract.ts';
import { toApiFailure } from '../../lib/api/index.ts';
import { useApi } from '../../lib/api/context.tsx';
import { BROWSERS_KEY } from '../../lib/query/browsers.ts';
import { useAppDispatch } from '../../store/hooks.ts';
import { pushToast } from '../../store/ui/actions.ts';
import { Badge } from '../../ui/Badge/Badge.tsx';
import { IconBtn } from '../../ui/IconBtn/IconBtn.tsx';
import { Row } from '../../ui/List/List.tsx';
import { Menu, MenuAnchor, MenuItem } from '../../ui/Menu/Menu.tsx';
import { Obj } from '../../ui/Obj/Obj.tsx';
import { Presence } from '../../ui/Overlay/presence.tsx';
import { DisconnectBrowserDialog } from './DisconnectBrowserDialog.tsx';
import { RenameBrowserDialog } from './RenameBrowserDialog.tsx';
import { browserMeta, browserStatusWords } from './Browsers.logic.ts';

export function BrowserRow({ browser, isThisBrowser, now }: { browser: BrowserView; isThisBrowser: boolean; now: Date }) {
  const api = useApi();
  const dispatch = useAppDispatch();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<'rename' | 'disconnect' | null>(null);
  const [busy, setBusy] = useState(false);
  const status = browserStatusWords(browser.online);

  const toggle = () => {
    const enable = !browser.enabledHere;

    setBusy(true);
    (enable ? api.browsers.enableHere(browser.id) : api.browsers.disableHere(browser.id))
      .then(
        () =>
          dispatch(
            pushToast({
              title: enable ? `“${browser.name}” is enabled in this workspace` : `“${browser.name}” is disabled in this workspace`,
              desc: enable ? 'Agents of this workspace can use it.' : 'Agents of this workspace cannot use it any more.',
              state: 'done',
            }),
          ),
        error => dispatch(pushToast({ title: `Couldn’t ${enable ? 'enable' : 'disable'} “${browser.name}” here`, desc: toApiFailure(error).message, state: 'err' })),
      )
      .finally(() => {
        setBusy(false);
        void queryClient.invalidateQueries({ queryKey: BROWSERS_KEY });
      });
  };

  return (
    <>
      <Row
        lead={<Obj icon="monitor" size="md" state={browser.enabledHere ? undefined : 'off'} />}
        title={browser.name}
        meta={browserMeta(browser, isThisBrowser, now)}
        end={
          <>
            <Badge state={status.state} label={status.label} />
            <MenuAnchor
              open={open}
              onClose={() => setOpen(false)}
              menu={
                <Menu label={`Actions of ${browser.name}`}>
                  <MenuItem
                    icon="pencil"
                    label="Rename…"
                    onClick={() => {
                      setOpen(false);
                      setDialog('rename');
                    }}
                  />
                  <MenuItem
                    icon={browser.enabledHere ? 'link-2-off' : 'link'}
                    label={browser.enabledHere ? 'Disable in this workspace' : 'Enable in this workspace'}
                    disabled={busy}
                    onClick={() => {
                      setOpen(false);
                      toggle();
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
              <IconBtn icon="ellipsis" label="Rename, enable or disable here, disconnect" size="sm" expanded={open} busy={busy} onClick={() => setOpen(!open)} />
            </MenuAnchor>
          </>
        }
      />
      <Presence>{dialog === 'rename' ? <RenameBrowserDialog browser={browser} onClose={() => setDialog(null)} /> : null}</Presence>
      <Presence>{dialog === 'disconnect' ? <DisconnectBrowserDialog browser={browser} onClose={() => setDialog(null)} /> : null}</Presence>
    </>
  );
}
