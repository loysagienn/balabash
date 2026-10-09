// Confirming the irreversible (rule 13): a Dialog with a plain explanation
// — a Modal on the desktop, a bottom Sheet on the phone (ui/Dialog picks
// by the width of the `shell` container).

import type { BtnVariant } from '../Btn/Btn.tsx';
import { Dialog } from '../Dialog/Dialog.tsx';
import type { IconName } from '../Icon/Icon.tsx';

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
  return <Dialog title={title} desc={children} confirm={confirm} confirmVariant={confirmVariant} confirmIcon={confirmIcon} cancel={cancel} busy={busy} onConfirm={onConfirm} onClose={onClose} />;
}
