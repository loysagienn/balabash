// A plate in place of the composer (design: ComposerLock): the thread is
// completed, crashed, cancelled or headless — children say which and what
// to do instead.

import type { ReactNode } from 'react';
import { Icon } from '../Icon/Icon.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import './Composer.css';

export function ComposerLock({ icon = 'lock', children }: { icon?: IconName; children: ReactNode }) {
  return (
    <div className="composer">
      <div className="composer-lock">
        <Icon name={icon} />
        <span>{children}</span>
      </div>
    </div>
  );
}
