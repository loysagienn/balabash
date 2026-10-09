// Settings — the full screen arrives with stage 5; the account part exists
// already: who is signed in and the way out.

import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { logout } from '../../store/session/actions.ts';
import { selectMe, selectSession } from '../../store/session/selectors.ts';
import { Shell } from '../../features/shell/Shell.tsx';
import { Btn } from '../../ui/Btn/Btn.tsx';
import { Empty } from '../../ui/Empty/Empty.tsx';
import { Screen } from '../../ui/Screen/Screen.tsx';
import { Code } from '../../ui/atoms/atoms.tsx';

export function SettingsScreen() {
  const dispatch = useAppDispatch();
  const me = useAppSelector(selectMe);
  const { logoutPending } = useAppSelector(selectSession);

  return (
    <Shell current="settings" title="Settings">
      <Screen>
        <Empty icon="sliders-horizontal" title="Settings are not built yet">
          Signed in to <b>{me?.workspaceName ?? 'the workspace'}</b> as <Code>{me?.userId ?? '—'}</Code>.
        </Empty>
        <div>
          <Btn label="Sign out" icon="log-out" busy={logoutPending} onClick={() => dispatch(logout())} />
        </div>
      </Screen>
    </Shell>
  );
}
