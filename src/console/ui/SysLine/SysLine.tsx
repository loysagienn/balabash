// System divider (design: SysLine) — an event of the whole thread, a full
// width line through the feed. level: normal (notifications, stages) ·
// urgent (bold, amber); state — the state color instead. Always one line:
// a text that does not fit ends in an ellipsis, and the line becomes a
// button that shows the whole text under the rule, centered across the
// feed; pressed again, it folds. Whether the text fits is measured (the
// text's scroll width against its box), and measured again as the feed
// resizes — a line that fits is a plain separator.

import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '../Icon/Icon.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import type { StateName } from '../atoms/state.ts';
import './SysLine.css';

export type SysLineProps = {
  icon?: IconName;
  level?: 'normal' | 'urgent';
  state?: StateName;
  children: ReactNode;
};

export function SysLine({ icon, level, state, children }: SysLineProps) {
  const text = useRef<HTMLSpanElement>(null);
  // The text does not fit on one line — the line is a button.
  const [clipped, setClipped] = useState(false);
  const [open, setOpen] = useState(false);

  // Measured while the text is on one line: open, it wraps and never
  // overflows — the measure would un-button the line under the user. The
  // button and the separator are different elements, so the text node is
  // a new one once the line turns — observed anew (clipped in the deps).
  useLayoutEffect(() => {
    const node = text.current;

    if (!node || open) {
      return undefined;
    }

    const measure = () => setClipped(node.scrollWidth > node.clientWidth);

    measure();

    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }

    const observer = new ResizeObserver(measure);

    observer.observe(node);

    return () => observer.disconnect();
  }, [open, clipped, children]);

  const body = (
    <>
      {icon ? <Icon name={icon} /> : null}
      <span ref={text} className="sysline-t">
        {children}
      </span>
    </>
  );

  return clipped ? (
    <button type="button" className="sysline" aria-expanded={open} data-level={level} data-state={state} onClick={() => setOpen(value => !value)}>
      {body}
    </button>
  ) : (
    <div className="sysline" role="separator" data-level={level} data-state={state}>
      {body}
    </div>
  );
}
