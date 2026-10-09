// The toasts of the screen from the store (ui.toasts): every pushToast
// becomes a Toast in the stack at the corner of the shell; "Close" and the
// timer (toasts.logic.ts) dismiss it. The icon follows the state.

import { useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { dismissToast } from '../../store/ui/actions.ts';
import type { Toast as ToastData } from '../../store/ui/reducer.ts';
import { selectToasts } from '../../store/ui/selectors.ts';
import type { IconName } from '../../ui/Icon/Icon.tsx';
import { Toast, ToastStack } from '../../ui/Toast/Toast.tsx';
import type { StateName } from '../../ui/atoms/state.ts';
import { toastTtl } from './toasts.logic.ts';

const ICON: Record<StateName, IconName> = {
  run: 'loader-circle',
  wait: 'clock',
  act: 'triangle-alert',
  done: 'circle-check',
  err: 'circle-alert',
  off: 'circle-slash',
};

export function Toasts({ tabs }: { tabs?: boolean }) {
  const toasts = useAppSelector(selectToasts);

  if (toasts.length === 0) {
    return null;
  }

  return (
    <ToastStack tabs={tabs}>
      {toasts.map(toast => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </ToastStack>
  );
}

function ToastItem({ toast }: { toast: ToastData }) {
  const dispatch = useAppDispatch();
  const ttl = toastTtl(toast.state);

  useEffect(() => {
    if (ttl === null) {
      return;
    }
    const timer = window.setTimeout(() => dispatch(dismissToast(toast.id)), ttl);

    return () => window.clearTimeout(timer);
  }, [dispatch, toast.id, ttl]);

  return (
    <Toast state={toast.state} icon={toast.state ? ICON[toast.state] : 'info'} title={toast.title} onClose={() => dispatch(dismissToast(toast.id))}>
      {toast.desc}
    </Toast>
  );
}
