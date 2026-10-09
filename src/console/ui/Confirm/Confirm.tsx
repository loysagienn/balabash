// Confirming the irreversible (rule 13): a Modal on the desktop, a bottom
// Sheet on the phone — one component that picks by the width of the
// `shell` container it is rendered in. Both dialogs render through a portal
// into document.body, so no container query reaches them; instead a hidden
// probe stays in place, a container query sets a custom property on it
// (Confirm.css), and the probe's parent is watched for resizes to read it
// again. Until the first read nothing is shown (a layout effect — no
// flicker).

import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { BtnVariant } from '../Btn/Btn.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import { Modal } from '../Modal/Modal.tsx';
import { Sheet } from '../Sheet/Sheet.tsx';
import './Confirm.css';

export type ConfirmProps = {
  title: string;
  // The explanation — plain text on the sheet (desc), the body of the modal.
  children: string;
  confirm: string;
  confirmVariant?: BtnVariant;
  confirmIcon?: IconName;
  cancel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
};

export function Confirm({ title, children, confirm, confirmVariant = 'danger', confirmIcon, cancel = 'Cancel', busy, onConfirm, onClose }: ConfirmProps) {
  const probe = useRef<HTMLSpanElement>(null);
  const narrow = useNarrowShell(probe);

  return (
    <>
      <span ref={probe} className="confirm-probe" hidden />
      {narrow === null ? null : narrow ? (
        <Sheet label={title} title={title} desc={children} confirm={confirm} confirmVariant={confirmVariant} confirmIcon={confirmIcon} cancel={cancel} busy={busy} onConfirm={onConfirm} onClose={onClose} />
      ) : (
        <Modal title={title} confirm={confirm} confirmVariant={confirmVariant} confirmIcon={confirmIcon} cancel={cancel} busy={busy} onConfirm={onConfirm} onClose={onClose}>
          {children}
        </Modal>
      )}
    </>
  );
}

// Whether the probe sits in a narrow shell: the container query of
// Confirm.css writes --confirm-narrow on it. null until the first read.
function useNarrowShell(probe: { current: HTMLElement | null }): boolean | null {
  const [narrow, setNarrow] = useState<boolean | null>(null);

  useLayoutEffect(() => {
    const el = probe.current;

    if (!el) {
      return;
    }
    const read = () => setNarrow(getComputedStyle(el).getPropertyValue('--confirm-narrow').trim() === '1');
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
