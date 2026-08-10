// Small presentation helpers shared by the window pages.

import type { ThreadStatus } from '../../api/contract.ts';

const dateTimeFormat = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatDateTime(date: Date): string {
  return dateTimeFormat.format(date);
}

export const STATUS_LABELS: Record<ThreadStatus, string> = {
  active: 'активный',
  completed: 'завершён',
  failed: 'ошибка',
  cancelled: 'отменён',
};
