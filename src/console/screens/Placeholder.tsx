// A section that has no screen yet (plan: stages 5 and 7): the shell with
// an honest empty state, nothing drawn that the data cannot back.

import { Shell } from '../features/shell/Shell.tsx';
import type { ShellProps } from '../features/shell/Shell.tsx';
import { Empty } from '../ui/Empty/Empty.tsx';
import type { IconName } from '../ui/Icon/Icon.tsx';
import { Screen } from '../ui/Screen/Screen.tsx';

export type PlaceholderProps = Omit<ShellProps, 'children'> & { icon: IconName; what: string };

export function Placeholder({ icon, what, ...shell }: PlaceholderProps) {
  return (
    <Shell {...shell}>
      <Screen>
        <Empty icon={icon} title={`${what} is not built yet`}>
          This screen arrives with a later stage of the console; the section and its data are already in the snapshot.
        </Empty>
      </Screen>
    </Shell>
  );
}
