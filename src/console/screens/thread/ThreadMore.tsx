// The "⋯" menu of the thread header: the parent thread, the child threads
// and "Copy link" — the links a narrow thread hides from the header and the
// rail. "Stop turn" and "Cancel thread" join with their endpoints (plan,
// stage 6).

import { useState } from 'react';
import type { Thread } from '../../../core/contract.ts';
import { writeRoute } from '../../lib/router/routes.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { routeTo } from '../../store/router/actions.ts';
import { useCopy } from '../../features/clipboard/useCopy.ts';
import { IconBtn } from '../../ui/IconBtn/IconBtn.tsx';
import { Menu, MenuAnchor, MenuItem, MenuLabel, MenuSep } from '../../ui/Menu/Menu.tsx';

const LINK_WORDS = { done: 'Link copied', fail: 'Couldn’t copy the link' };

function ChildMenuItem({ id, onPick }: { id: string; onPick: () => void }) {
  const dispatch = useAppDispatch();
  const child = useAppSelector(s => s.threads.byId[id]);

  if (!child) {
    return null;
  }

  return (
    <MenuItem
      icon="arrow-up-right"
      label={`${child.agent} · ${child.title?.trim() || child.agent}`}
      onClick={() => {
        onPick();
        dispatch(routeTo({ key: 'thread', id }));
      }}
    />
  );
}

export function ThreadMore({ thread, parent, childIds, open, onOpenChange }: { thread: Thread; parent: Thread | null; childIds: string[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const dispatch = useAppDispatch();
  const copy = useCopy();
  const [copied, setCopied] = useState(false);
  const close = () => onOpenChange(false);
  const copyLink = async () => {
    close();

    if (await copy(`${window.location.origin}${writeRoute({ key: 'thread', id: thread.id })}`, LINK_WORDS)) {
      setCopied(true);
    }
  };

  return (
    <MenuAnchor
      open={open}
      onClose={close}
      menu={
        <Menu label="Thread">
          {parent || childIds.length > 0 ? (
            <>
              <MenuLabel>Links</MenuLabel>
              {parent ? (
                <MenuItem
                  icon="git-fork"
                  label={`Parent · ${parent.title?.trim() || parent.agent}`}
                  onClick={() => {
                    close();
                    dispatch(routeTo({ key: 'thread', id: parent.id }));
                  }}
                />
              ) : null}
              {childIds.map(id => (
                <ChildMenuItem key={id} id={id} onPick={close} />
              ))}
              <MenuSep />
            </>
          ) : null}
          <MenuItem icon={copied ? 'check' : 'link'} label="Copy link" onClick={() => void copyLink()} />
        </Menu>
      }
    >
      <IconBtn icon="ellipsis" label="More: links, copy link" size="sm" className="th-more" expanded={open} onClick={() => onOpenChange(!open)} />
    </MenuAnchor>
  );
}
