// Modal over the screen (design: Modal): title, body (children), "Cancel"
// and the main action; danger — confirmVariant="danger". Rendered through
// a portal into document.body, so the scrim covers everything but the
// window; Escape and a click outside the window close it (the click lands
// on the centering layer, which sits over the scrim). On the phone the same
// question is a Sheet. bare — the window alone, for the showcase.

import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Btn } from '../Btn/Btn.tsx';
import type { BtnVariant } from '../Btn/Btn.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import { IconBtn } from '../IconBtn/IconBtn.tsx';
import { Scrim } from '../Scrim/Scrim.tsx';
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
  const dialog = useRef<HTMLDivElement>(null);
  // Who had the focus when the modal was opened (read during the first
  // render, before an autoFocus field inside takes it); it gets it back.
  const [opener] = useState(() => (bare ? null : (document.activeElement as HTMLElement | null)));

  useEffect(() => {
    if (bare) {
      return;
    }

    // An autoFocus field inside keeps the focus; otherwise the window takes it.
    if (!dialog.current?.contains(document.activeElement)) {
      dialog.current?.focus();
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };

    window.addEventListener('keydown', onKey);

    return () => {
      window.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [bare, onClose, opener]);

  const window_ = (
    <div ref={dialog} className="modal" role="dialog" aria-modal="true" aria-labelledby={id} aria-busy={busy ? 'true' : undefined} tabIndex={-1} style={width ? ({ '--modal-w': width } as CSSProperties) : undefined}>
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

  return createPortal(
    <>
      <Scrim onClick={onClose} />
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
    </>,
    document.body,
  );
}
