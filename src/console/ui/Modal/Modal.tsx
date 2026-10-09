// Modal over the screen (design: Modal): title, body (children), "Cancel"
// and the main action; danger — confirmVariant="danger". Rendered through
// an Overlay (a portal into document.body), so the scrim covers everything
// but the window, the rest of the page is inert and the focus stays
// inside; Escape and a click outside the window close it (the click lands
// on the centering layer, which sits over the scrim). It can submit a form
// in its body (form="<id>"). On the phone the same question is a Sheet.
// bare — the window alone, for the showcase.

import { useId } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Btn } from '../Btn/Btn.tsx';
import type { BtnVariant } from '../Btn/Btn.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import { IconBtn } from '../IconBtn/IconBtn.tsx';
import { Overlay } from '../Overlay/Overlay.tsx';
import './Modal.css';

export type ModalProps = {
  title: string;
  cancel?: string;
  confirm?: string;
  confirmVariant?: BtnVariant;
  confirmIcon?: IconName;
  confirmDisabled?: boolean;
  busy?: boolean;
  // Overrides --modal-w, e.g. "560px".
  width?: string;
  onClose: () => void;
  onConfirm?: () => void;
  // The confirm button submits this form (so Enter in a field confirms).
  form?: string;
  bare?: boolean;
  children?: ReactNode;
};

export function Modal({ title, cancel = 'Cancel', confirm, confirmVariant = 'primary', confirmIcon, confirmDisabled, busy, width, onClose, onConfirm, form, bare, children }: ModalProps) {
  const id = useId();

  const window_ = (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby={id} aria-busy={busy ? 'true' : undefined} tabIndex={-1} style={width ? ({ '--modal-w': width } as CSSProperties) : undefined}>
      <div className="modal-h">
        <h3 className="modal-t" id={id}>
          {title}
        </h3>
        <IconBtn icon="x" label="Close" size="sm" className="modal-close" onClick={onClose} />
      </div>
      <div className="modal-b">{children}</div>
      <div className="modal-f">
        <Btn label={cancel} variant="ghost" onClick={onClose} />
        {confirm ? <Btn label={confirm} icon={confirmIcon} variant={confirmVariant} busy={busy} disabled={confirmDisabled} type={form ? 'submit' : 'button'} form={form} onClick={form ? undefined : onConfirm} /> : null}
      </div>
    </div>
  );

  if (bare) {
    return window_;
  }

  return (
    <Overlay onClose={onClose}>
      <div
        className="modal-layer"
        onClick={event => {
          if (event.target === event.currentTarget) {
            onClose();
          }
        }}
      >
        {window_}
      </div>
    </Overlay>
  );
}
