// The "⋯" of an app row: open the app, open it as the owner (/apps/<path>
// on this host — every app has that page, published or not), its folder in
// Files, copy the public link; then publish (the slug dialog) or unpublish
// (the confirmation) — the dialogs of features/apps over the app.* calls
// of the store. The chosen dialog is shown only while the row's publication
// still calls for it (publicationDialog): the choice is forgotten the
// moment the publication changed under it.

import { useEffect, useState } from 'react';
import type { AppListingView } from '../../../api/contract.ts';
import type { AppLink } from '../../lib/apps/appLink.ts';
import { useAppDispatch } from '../../store/hooks.ts';
import { routeTo } from '../../store/router/actions.ts';
import { useCopy } from '../../features/clipboard/useCopy.ts';
import { PublishAppDialog } from '../../features/apps/PublishAppDialog.tsx';
import { UnpublishAppDialog } from '../../features/apps/UnpublishAppDialog.tsx';
import { publicationDialog } from '../../features/apps/publishApp.logic.ts';
import type { PublicationDialog } from '../../features/apps/publishApp.logic.ts';
import { IconBtn } from '../../ui/IconBtn/IconBtn.tsx';
import { Menu, MenuAnchor, MenuItem, MenuSep } from '../../ui/Menu/Menu.tsx';

const LINK_WORDS = { done: 'Link copied', fail: 'Couldn’t copy the link' };

export function AppMenu({ app, link }: { app: AppListingView; link: AppLink }) {
  const dispatch = useAppDispatch();
  const copy = useCopy();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<PublicationDialog>(null);
  const close = () => setOpen(false);
  const { address, href, owner } = link;
  const shown = publicationDialog(dialog, address !== null);

  useEffect(() => {
    if (dialog !== null && shown === null) {
      setDialog(null);
    }
  }, [dialog, shown]);

  return (
    <>
      <MenuAnchor
        open={open}
        onClose={close}
        menu={
          <Menu label="App actions">
            {href ? (
              <MenuItem
                icon="arrow-up-right"
                label="Open"
                onClick={() => {
                  close();
                  window.open(href, '_blank', 'noopener');
                }}
              />
            ) : null}
            <MenuItem
              icon="user-round"
              label="Open as owner"
              onClick={() => {
                close();
                window.open(owner, '_blank', 'noopener');
              }}
            />
            <MenuItem
              icon="folder-open"
              label="Folder in Files"
              onClick={() => {
                close();
                dispatch(routeTo({ key: 'files', path: app.path }));
              }}
            />
            {address ? (
              <MenuItem
                icon="link"
                label="Copy link"
                onClick={() => {
                  close();
                  void copy(address, LINK_WORDS);
                }}
              />
            ) : null}
            <MenuSep />
            {address ? (
              <MenuItem
                icon="globe-lock"
                label="Unpublish…"
                variant="danger"
                onClick={() => {
                  close();
                  setDialog('unpublish');
                }}
              />
            ) : (
              <MenuItem
                icon="globe"
                label="Publish…"
                onClick={() => {
                  close();
                  setDialog('publish');
                }}
              />
            )}
          </Menu>
        }
      >
        <IconBtn icon="ellipsis" label="App actions" size="sm" expanded={open} onClick={() => setOpen(!open)} />
      </MenuAnchor>
      {shown === 'publish' ? <PublishAppDialog app={app} onClose={() => setDialog(null)} /> : null}
      {shown === 'unpublish' && address ? <UnpublishAppDialog app={app} address={address} onClose={() => setDialog(null)} /> : null}
    </>
  );
}
