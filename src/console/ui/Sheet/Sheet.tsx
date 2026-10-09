// Bottom sheet (design: Sheet) over a scrim: confirmation, form or details
// on the phone. Escape and the scrim close it; buttons are full width, the
// main one on top.

import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Btn } from '../Btn/Btn.tsx';
import type { BtnVariant } from '../Btn/Btn.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import './Sheet.css';

export type SheetProps = {
  label: string;
  title?: string;
  desc?: string;
  confirm?: string;
  confirmVariant?: BtnVariant;
  confirmIcon?: IconName;
  confirmDisabled?: boolean;
  onConfirm?: () => void;
  cancel?: string;
  onClose: () => void;
  children?: ReactNode;
};

export function Sheet({ label, title, desc, confirm, confirmVariant = 'primary', confirmIcon, confirmDisabled, onConfirm, cancel, onClose, children }: SheetProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={label} data-dock="bottom">
        <div className="sheet-grab" />
        {title ? <h3 className="sheet-t">{title}</h3> : null}
        {desc ? <p className="sheet-d">{desc}</p> : null}
        {children}
        {confirm ? <Btn label={confirm} icon={confirmIcon} variant={confirmVariant} block disabled={confirmDisabled} onClick={onConfirm} /> : null}
        {cancel ? <Btn label={cancel} variant="ghost" block onClick={onClose} /> : null}
      </div>
    </>
  );
}
