// The workspace switcher (design: WsSwitcher, WsItem; spec
// design/multi-workspace.md): every workspace this browser is signed in to,
// "Sign in to another workspace" and "Sign out of <current>". On the desktop
// it is the sidebar head's button with a menu; on the phone the current
// workspace's mark starts the header of a top-level screen and opens the
// same list as a bottom sheet. Choosing a workspace loads Home of it
// (lib/workspace, switchWorkspace). "Sign in to another workspace" is the
// code window (AddWorkspaceDialog), rendered once by the shell and opened
// through the store (ui.addWorkspace) — from here, from Settings and from
// the /login door of a signed-in tab.

import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { useApi } from '../../lib/api/context.tsx';
import { toApiFailure } from '../../lib/api/index.ts';
import type { ApiFailure } from '../../lib/api/index.ts';
import { switchWorkspace } from '../../lib/workspace/index.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { logout } from '../../store/session/actions.ts';
import { selectSession } from '../../store/session/selectors.ts';
import { closeAddWorkspace, openAddWorkspace } from '../../store/ui/actions.ts';
import { selectAddWorkspace } from '../../store/ui/selectors.ts';
import { Btn } from '../../ui/Btn/Btn.tsx';
import { Presence } from '../../ui/Overlay/presence.tsx';
import { Dialog } from '../../ui/Dialog/Dialog.tsx';
import { Field } from '../../ui/Field/Field.tsx';
import { Icon } from '../../ui/Icon/Icon.tsx';
import { Input } from '../../ui/Input/Input.tsx';
import { Menu, MenuAnchor, MenuItem, MenuLabel, MenuSep } from '../../ui/Menu/Menu.tsx';
import { Sheet } from '../../ui/Sheet/Sheet.tsx';
import { WsMark } from '../../ui/WsMark/WsMark.tsx';
import { errorWords } from '../../screens/outside/SignIn.logic.ts';
import { useWorkspaces } from './queries.ts';
import type { WorkspaceItem } from './workspaces.logic.ts';
import { addOutcome } from './workspaces.logic.ts';
import './Workspaces.css';

function choose(item: WorkspaceItem): void {
  if (!item.current) {
    switchWorkspace(item.workspaceId);
  }
}

// A workspace in the list: mark, name, operator; the current one checked.
function WsRow({ item, big }: { item: WorkspaceItem; big?: boolean }) {
  return (
    <button type="button" className="wsi" role="menuitemradio" aria-checked={item.current} onClick={() => choose(item)}>
      <WsMark name={item.name} color={item.color} size={big ? undefined : 'sm'} />
      <span className="wsi-main">
        <span className="wsi-t">{item.name}</span>
        {item.operator ? <span className="wsi-m">{item.operator}</span> : null}
      </span>
      {item.current ? (
        <span className="wsi-end">
          <Icon name="check" aria-label="Current workspace" />
        </span>
      ) : null}
    </button>
  );
}

// The sidebar head's switcher (desktop): the current workspace as a button,
// the menu under it.
export function WorkspaceSwitcher() {
  const dispatch = useAppDispatch();
  const { logoutPending } = useAppSelector(selectSession);
  const { items, current } = useWorkspaces();
  const [open, setOpen] = useState(false);

  if (!current) {
    return null;
  }

  const menu = (
    <Menu label="Workspaces" className="wsmenu">
      <MenuLabel>Workspaces</MenuLabel>
      {items.map(item => (
        <WsRow key={item.workspaceId} item={item} />
      ))}
      <MenuSep />
      <MenuItem
        icon="plus"
        label="Sign in to another workspace"
        onClick={() => {
          setOpen(false);
          dispatch(openAddWorkspace());
        }}
      />
      <MenuItem
        icon="log-out"
        label={`Sign out of ${current.name}`}
        disabled={logoutPending}
        onClick={() => {
          setOpen(false);
          dispatch(logout());
        }}
      />
    </Menu>
  );

  return (
    <MenuAnchor open={open} onClose={() => setOpen(false)} menu={menu} align="start" className="shell-ws-anchor">
      <button type="button" className="shell-ws" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <WsMark name={current.name} color={current.color} />
        <span className="shell-ws-main">
          <b className="shell-ws-name">{current.name}</b>
          {current.operator ? <small className="shell-ws-sub">{current.operator}</small> : null}
        </span>
        <span className="shell-ws-end">
          <Icon name="chevrons-up-down" size="sm" />
        </span>
      </button>
    </MenuAnchor>
  );
}

// The phone header's mark: opens the list as a sheet.
export function WorkspaceSheetButton() {
  const dispatch = useAppDispatch();
  const { logoutPending } = useAppSelector(selectSession);
  const { items, current } = useWorkspaces();
  const [open, setOpen] = useState(false);

  if (!current) {
    return null;
  }

  return (
    <>
      <button type="button" className="btn shell-ws-btn" data-variant="ghost" data-icon-only="" aria-label={`Workspace: ${current.name}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        <WsMark name={current.name} color={current.color} />
      </button>
      <Presence>
        {open ? (
          <Sheet label="Workspaces" title="Workspaces" onClose={() => setOpen(false)}>
            <div className="wslist" role="menu" aria-label="Workspaces">
              {items.map(item => (
                <WsRow key={item.workspaceId} item={item} big />
              ))}
            </div>
            <div className="wssheet-actions">
              <Btn
                label="Sign in to another workspace"
                icon="plus"
                block
                onClick={() => {
                  setOpen(false);
                  dispatch(openAddWorkspace());
                }}
              />
              <Btn label={`Sign out of ${current.name}`} icon="log-out" variant="ghost" block busy={logoutPending} onClick={() => dispatch(logout())} />
            </div>
          </Sheet>
        ) : null}
      </Presence>
    </>
  );
}

// "Sign in to another workspace": the one-time code field and the button,
// nothing else (as the sign-in screen). The code decides the workspace: a
// new one opens with a toast and the way back; one already signed in on this
// browser just opens; the tab's own — the window closes.
export function AddWorkspaceDialog() {
  const open = useAppSelector(selectAddWorkspace);

  return <Presence>{open ? <AddWorkspaceWindow /> : null}</Presence>;
}

function AddWorkspaceWindow() {
  const api = useApi();
  const dispatch = useAppDispatch();
  const { items, current } = useWorkspaces();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);
  const form = useId();
  const trimmed = code.trim();
  const close = () => dispatch(closeAddWorkspace());

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();

    if (!trimmed || busy) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const me = await api.auth(trimmed);
      const outcome = addOutcome(
        me.workspaceId,
        current?.workspaceId ?? null,
        items.map(item => item.workspaceId),
      );

      if (outcome.kind === 'same') {
        setBusy(false);
        close();
      } else if (outcome.kind === 'switch') {
        switchWorkspace(outcome.workspaceId);
      } else {
        switchWorkspace(outcome.workspaceId, { kind: 'signed-in', back: current ? { workspaceId: current.workspaceId, name: current.name } : null });
      }
    } catch (failure) {
      setBusy(false);
      setError(toApiFailure(failure));
    }
  };

  return (
    <Dialog title="Sign in to another workspace" confirm={busy ? 'Signing in' : 'Sign in'} confirmIcon="log-in" confirmDisabled={!trimmed} busy={busy} form={form} onClose={close}>
      <form id={form} className="form" onSubmit={onSubmit}>
        <Field label="One-time code" fid={`${form}-code`} required err={error ? errorWords(error) : undefined}>
          <Input
            id={`${form}-code`}
            value={code}
            onChange={setCode}
            mono
            autoFocus
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            invalid={error !== null}
            disabled={busy}
            ariaLabel="One-time code"
          />
        </Field>
      </form>
    </Dialog>
  );
}

