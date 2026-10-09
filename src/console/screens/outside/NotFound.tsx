// 404 (design: OutsideScreen, variant 404): one card, the URL that led
// nowhere, a way home.

import { useAppDispatch } from '../../store/hooks.ts';
import { routeTo } from '../../store/router/actions.ts';
import { Btn } from '../../ui/Btn/Btn.tsx';
import { Solo, SoloText } from '../../ui/Solo/Solo.tsx';
import { Code } from '../../ui/atoms/atoms.tsx';

export function NotFound({ url }: { url: string }) {
  const dispatch = useAppDispatch();

  return (
    <Solo brand="Balabash · 404" icon="map-pin-off" title="Page not found">
      <SoloText>
        There’s nothing at <Code wrap>{url}</Code>: the page was removed or the link is wrong.
      </SoloText>
      <Btn label="Go home" icon="house" variant="primary" block onClick={() => dispatch(routeTo({ key: 'home' }))} />
    </Solo>
  );
}
