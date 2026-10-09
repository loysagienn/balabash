// Bottom sheet (design: Sheet) over a scrim: confirmation, form or details
// on the phone. Rendered through an Overlay (a portal into document.body),
// so it docks to the window wherever it is opened from; the rest of the
// page is inert, the focus stays inside, Escape and the scrim close it.
// Buttons are full width, the main one on top. It can submit a form in
// its body (form="<id>"), like the Modal. The sheet is never taller than
// the window: a long body (a form with its errors on a short phone screen)
// scrolls inside .sheet-b while the title and the buttons stay in reach.

import type { ReactNode } from 'react';
import { Btn } from '../Btn/Btn.tsx';
import type { BtnVariant } from '../Btn/Btn.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import { Overlay } from '../Overlay/Overlay.tsx';
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
  cancel?: string;
  onClose: () => void;
  children?: ReactNode;
};

export function Sheet({ label, title, desc, confirm, confirmVariant = 'primary', confirmIcon, confirmDisabled, busy, form, onConfirm, cancel, onClose, children }: SheetProps) {
  return (
    <Overlay onClose={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={label} aria-busy={busy ? 'true' : undefined} data-dock="bottom" tabIndex={-1}>
        <div className="sheet-grab" />
        {title ? <h3 className="sheet-t">{title}</h3> : null}
        {desc ? <p className="sheet-d">{desc}</p> : null}
        {children ? <div className="sheet-b">{children}</div> : null}
        {confirm ? <Btn label={confirm} icon={confirmIcon} variant={confirmVariant} block busy={busy} disabled={confirmDisabled} type={form ? 'submit' : 'button'} form={form} onClick={form ? undefined : onConfirm} /> : null}
        {cancel ? <Btn label={cancel} variant="ghost" block onClick={onClose} /> : null}
      </div>
    </Overlay>
  );
}
