// A dialog that fits the shell: a Modal on the desktop, a bottom Sheet on
// the phone — one component that picks by the width of the `shell`
// container it is rendered in (the design draws creation and confirmation
// as a modal at 1440 and a sheet at 390). Both windows render through a
// portal into document.body, so no container query reaches them; instead
// a hidden probe stays in place, a container query sets a custom property
// on it (Dialog.css), and the probe's parent is watched for resizes to
// read it again. Until the first read nothing is shown (a layout effect —
// no flicker). `desc` is the plain explanation (the sheet's own line, the
// modal's body when there are no children); `children` — a form or any
// body, the same in both windows; `form` makes the confirm button submit
// that form in either.

import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { BtnVariant } from '../Btn/Btn.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import { Modal } from '../Modal/Modal.tsx';
import { Sheet } from '../Sheet/Sheet.tsx';
import './Dialog.css';

export type DialogProps = {
  title: string;
  desc?: string;
  confirm?: string;
  confirmVariant?: BtnVariant;
  confirmIcon?: IconName;
  confirmDisabled?: boolean;
  cancel?: string;
  busy?: boolean;
  // The confirm button submits this form (Enter in a field confirms).
  form?: string;
  onConfirm?: () => void;
  onClose: () => void;
  children?: ReactNode;
};

export function Dialog({ title, desc, confirm, confirmVariant = 'primary', confirmIcon, confirmDisabled, cancel = 'Cancel', busy, form, onConfirm, onClose, children }: DialogProps) {
  const probe = useRef<HTMLSpanElement>(null);
  const narrow = useNarrowShell(probe);

  return (
    <>
      <span ref={probe} className="dialog-probe" hidden />
      {narrow === null ? null : narrow ? (
        <Sheet label={title} title={title} desc={desc} confirm={confirm} confirmVariant={confirmVariant} confirmIcon={confirmIcon} confirmDisabled={confirmDisabled} cancel={cancel} busy={busy} form={form} onConfirm={onConfirm} onClose={onClose}>
          {children}
        </Sheet>
      ) : (
        <Modal title={title} confirm={confirm} confirmVariant={confirmVariant} confirmIcon={confirmIcon} confirmDisabled={confirmDisabled} cancel={cancel} busy={busy} form={form} onConfirm={onConfirm} onClose={onClose}>
          {children ?? desc}
        </Modal>
      )}
    </>
  );
}

// Whether the probe sits in a narrow shell: the container query of
// Dialog.css writes --dialog-narrow on it. null until the first read.
function useNarrowShell(probe: { current: HTMLElement | null }): boolean | null {
  const [narrow, setNarrow] = useState<boolean | null>(null);

  useLayoutEffect(() => {
    const el = probe.current;

    if (!el) {
      return;
    }
    const read = () => setNarrow(getComputedStyle(el).getPropertyValue('--dialog-narrow').trim() === '1');
    const observer = new ResizeObserver(read);

    // The probe itself is hidden (no box to observe): its parent changes
    // size with the container; the root catches the window.
    if (el.parentElement) {
      observer.observe(el.parentElement);
    }
    observer.observe(document.documentElement);
    read();

    return () => observer.disconnect();
  }, [probe]);

  return narrow;
}
