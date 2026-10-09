// The console broke while drawing a page (design: Solo, the error card —
// the one SessionError draws): the error's words and two ways out that
// need nothing of the app that just failed — a reload, or home by a plain
// navigation. Rendered by app/ErrorBoundary.tsx; no store, no router.

import { Btn } from '../../ui/Btn/Btn.tsx';
import { Solo, SoloText } from '../../ui/Solo/Solo.tsx';
import { Code } from '../../ui/atoms/atoms.tsx';

export function Crashed({ message }: { message: string }) {
  return (
    <Solo brand="Balabash · error" icon="triangle-alert" iconState="err" title="The console broke">
      <SoloText>
        Something went wrong while drawing this page: <Code wrap>{message}</Code>. Reloading usually helps; if it keeps happening, this message is what to report.
      </SoloText>
      <Btn label="Reload page" icon="refresh-cw" variant="primary" block onClick={() => window.location.reload()} />
      <Btn label="Go home" icon="house" block onClick={() => window.location.assign('/')} />
    </Solo>
  );
}
