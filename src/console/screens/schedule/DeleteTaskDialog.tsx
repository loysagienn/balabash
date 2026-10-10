// "Delete task …?" (design: ScheduleScreen sheet): the confirmation of the
// irreversible (rule 13) over DELETE_TASK. The task will no longer run;
// its run log stays. The dialog stays, busy, while the call runs and
// closes when it ended — the outcome is a toast (store/schedule/handlers.ts).

import { useEffect, useState } from 'react';
import type { TaskView } from '../../../api/contract.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { deleteTask } from '../../store/schedule/actions.ts';
import { selectTaskCall } from '../../store/schedule/selectors.ts';
import { Confirm } from '../../ui/Confirm/Confirm.tsx';

export function DeleteTaskDialog({ task, onClose }: { task: TaskView; onClose: () => void }) {
  const dispatch = useAppDispatch();
  const call = useAppSelector(s => selectTaskCall(s, task.slug));
  const [sent, setSent] = useState(false);
  const busy = call !== null;

  useEffect(() => {
    if (sent && !busy) {
      onClose();
    }
  }, [sent, busy, onClose]);

  return (
    <Confirm
      title={`Delete task “${task.name}”?`}
      confirm="Delete task"
      confirmIcon="trash-2"
      cancel="Keep"
      busy={busy}
      onConfirm={() => {
        if (busy) {
          return;
        }

        dispatch(deleteTask(task.slug));
        setSent(true);
      }}
      onClose={onClose}
    >
      {task.kind === 'command' ? 'The task will no longer run. Its run log stays.' : 'The task will no longer run; its trigger is disarmed at once.'}
    </Confirm>
  );
}
