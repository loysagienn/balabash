// The session check itself failed (the server is unreachable, a 5xx):
// one card with the reason and a retry.

import type { ApiFailure } from '../../lib/api/index.ts';
import { useAppDispatch } from '../../store/hooks.ts';
import { sessionCheck } from '../../store/session/actions.ts';
import { Btn } from '../../ui/Btn/Btn.tsx';
import { Solo, SoloText } from '../../ui/Solo/Solo.tsx';
import { Code } from '../../ui/atoms/atoms.tsx';

export function SessionError({ error }: { error: ApiFailure }) {
  const dispatch = useAppDispatch();

  return (
    <Solo brand="Balabash · error" icon="circle-x" iconState="err" title="Couldn’t reach Balabash">
      <SoloText>
        The session check failed: <Code wrap>{error.status ? `HTTP ${error.status} · ${error.code}` : error.message}</Code>.
      </SoloText>
      <Btn label="Try again" icon="refresh-cw" block onClick={() => dispatch(sessionCheck())} />
    </Solo>
  );
}
