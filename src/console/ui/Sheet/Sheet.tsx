// Bottom sheet (design: Sheet) over a scrim: confirmation, form or details
// on the phone. Rendered through an Overlay (a portal into document.body),
// so it docks to the window wherever it is opened from; the rest of the
// page is inert, the focus stays inside, Escape and the scrim close it.
// It rises from the bottom edge and sinks back (Overlay, motion "sheet";
// the way out plays when a Presence keeps it — ui/Overlay/presence), and
// its head — the grab, the title, the description — can be pulled down to
// close it (useSheetDrag). Buttons are full width, the main one on top.
// It can submit a form in its body (form="<id>"), like the Modal. The
// sheet is never taller than the window: a long body (a form with its
// errors on a short phone screen) scrolls inside .sheet-b while the title
// and the buttons stay in reach.

import type { ReactNode } from 'react';
import { Btn } from '../Btn/Btn.tsx';
import type { BtnVariant } from '../Btn/Btn.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import { Overlay } from '../Overlay/Overlay.tsx';
import { useSheetDrag } from './useSheetDrag.ts';
import './Sheet.css';

export type SheetProps = {
  label: string;
  title?: string;
  desc?: string;
  confirm?: string;
  confirmVariant?: BtnVariant;
  confirmIcon?: IconName;
  confirmDisabled?: boolean;
  busy?: boolean;
  // The confirm button submits this form (so Enter in a field confirms).
  form?: string;
  onConfirm?: () => void;
  // A second ordinary action under the main one (design: Sheet `alt`).
  alt?: string;
  onAlt?: () => void;
  cancel?: string;
  onClose: () => void;
  children?: ReactNode;
};

export function Sheet({
  label,
  title,
  desc,
  confirm,
  confirmVariant = 'primary',
  confirmIcon,
  confirmDisabled,
  busy,
  form,
  onConfirm,
  alt,
  onAlt,
  cancel,
  onClose,
  children,
}: SheetProps) {
  const drag = useSheetDrag(onClose);

  return (
    <Overlay onClose={onClose} motion="sheet" exitFrom={drag.exitFrom}>
      <div
        ref={drag.sheetRef}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-busy={busy ? 'true' : undefined}
        data-dock="bottom"
        tabIndex={-1}
      >
        <div ref={drag.headRef} className="sheet-head">
          <div className="sheet-grab" />
          {title ? <h3 className="sheet-t">{title}</h3> : null}
          {desc ? <p className="sheet-d">{desc}</p> : null}
        </div>
        {children ? <div className="sheet-b">{children}</div> : null}
        {confirm ? (
          <Btn
            label={confirm}
            icon={confirmIcon}
            variant={confirmVariant}
            block
            busy={busy}
            disabled={confirmDisabled}
            type={form ? 'submit' : 'button'}
            form={form}
            onClick={form ? undefined : onConfirm}
          />
        ) : null}
        {alt ? <Btn label={alt} block onClick={onAlt} /> : null}
        {cancel ? <Btn label={cancel} variant="ghost" block onClick={onClose} /> : null}
      </div>
    </Overlay>
  );
}
