// The "⋯" of an app row: open the app, its folder in Files, copy the public
// link. Publish and unpublish join with their endpoints and the app.*
// events of the registry (plan, stages 6–7).

import { useState } from 'react';
import type { AppListingView } from '../../../api/contract.ts';
import { useAppDispatch } from '../../store/hooks.ts';
import { routeTo } from '../../store/router/actions.ts';
import { useCopy } from '../../features/clipboard/useCopy.ts';
import { IconBtn } from '../../ui/IconBtn/IconBtn.tsx';
import { Menu, MenuAnchor, MenuItem } from '../../ui/Menu/Menu.tsx';

const LINK_WORDS = { done: 'Link copied', fail: 'Couldn’t copy the link' };

export function AppMenu({ app, address, href }: { app: AppListingView; address: string | null; href: string | null }) {
  const dispatch = useAppDispatch();
  const copy = useCopy();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
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
        </Menu>
      }
    >
      <IconBtn icon="ellipsis" label="App actions" size="sm" expanded={open} onClick={() => setOpen(!open)} />
    </MenuAnchor>
  );
}
