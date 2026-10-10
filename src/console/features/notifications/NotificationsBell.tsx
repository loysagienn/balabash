// The bell of the shell header with its popover (design: Bell, App Shell
// "Activity and notifications"): the count of unread rows on the bell, the
// rows grouped — waiting for you, errors, from agents — in a Pop floating
// under the bell (ui/Float). A row's action opens its route and marks the
// row read; "Mark all read" marks every row. The rows — store/notifications,
// the connections and the open requests for credentials
// (notifications.logic.ts); the time column ticks by
// the minute while the popover is open. The focus: on open it lands on the
// named dialog (the Pop), and "Mark all read" hands it back there before
// its button leaves the DOM — a keyboard user keeps a place in the popover.

import { useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { createSelector } from 'reselect';
import { briefAgoLabel } from '../../lib/format/index.ts';
import { useNow } from '../../lib/format/useNow.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { selectConnections } from '../../store/connections/selectors.ts';
import { markNotificationsRead } from '../../store/notifications/actions.ts';
import { selectNotificationItems, selectNotificationsRead } from '../../store/notifications/selectors.ts';
import { routeTo } from '../../store/router/actions.ts';
import { selectSecretRequests } from '../../store/secret-requests/selectors.ts';
import { selectMe } from '../../store/session/selectors.ts';
import { selectThreadsById } from '../../store/threads/selectors.ts';
import { Bell } from '../../ui/Bell/Bell.tsx';
import { Btn } from '../../ui/Btn/Btn.tsx';
import { FloatLayer } from '../../ui/Float/Float.tsx';
import { Notification } from '../../ui/Notification/Notification.tsx';
import { Pop, PopGroup, PopHead } from '../../ui/Pop/Pop.tsx';
import { GROUPS, notificationViews, unreadCount, unreadKeys } from './notifications.logic.ts';
import type { NotificationView } from './notifications.logic.ts';
import './Notifications.css';

const selectNotificationViews = createSelector(
  [selectNotificationItems, selectNotificationsRead, selectConnections, selectSecretRequests, selectThreadsById, (state: Parameters<typeof selectMe>[0]) => selectMe(state)?.mainThreadId ?? null],
  (items, read, connections, secretRequests, threads, mainThreadId) => notificationViews({ items, read, connections, secretRequests, threads, mainThreadId }),
);

export function NotificationsBell() {
  const views = useAppSelector(selectNotificationViews);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const unread = unreadCount(views);

  return (
    <span ref={anchor} className="ntfs-anchor">
      <Bell count={unread} expanded={open} onClick={() => setOpen(!open)} />
      {open ? (
        <FloatLayer anchor={anchor} onClose={() => setOpen(false)} className="ntfs-layer" focus={() => pop.current?.focus()}>
          <NotificationsPop ref={pop} views={views} unread={unread} onDone={() => setOpen(false)} />
        </FloatLayer>
      ) : null}
    </span>
  );
}

function NotificationsPop({ ref, views, unread, onDone }: { ref: RefObject<HTMLDivElement | null>; views: NotificationView[]; unread: number; onDone: () => void }) {
  const dispatch = useAppDispatch();
  const now = useNow();
  const groups = useMemo(() => GROUPS.map(group => ({ ...group, rows: views.filter(view => view.group === group.key) })).filter(group => group.rows.length > 0), [views]);

  const act = (view: NotificationView) => {
    if (!view.action) {
      return;
    }

    dispatch(markNotificationsRead([view.key]));
    dispatch(routeTo(view.action.route));
    onDone();
  };

  // The button goes with the last unread row: the focus moves to the dialog first.
  const readAll = () => {
    ref.current?.focus();
    dispatch(markNotificationsRead(unreadKeys(views)));
  };

  return (
    <Pop ref={ref} label="Notifications" className="ntfs-pop">
      <PopHead title="Notifications" count={unread} countState="act" end={unread > 0 ? <Btn label="Mark all read" variant="ghost" size="sm" onClick={readAll} /> : undefined} />
      <div className="ntfs-list">
        {groups.length === 0 ? <p className="ntfs-empty">Nothing new. Urgent notes from agents, system errors and sign-ins that await you will show up here.</p> : null}
        {groups.map(group => (
          <div key={group.key} className="ntfs-group">
            <PopGroup>{group.label}</PopGroup>
            {group.rows.map(view => (
              <Notification key={view.key} icon={view.icon} state={view.state} title={view.title} desc={view.desc} action={view.action?.label} onAction={() => act(view)} time={briefAgoLabel(view.at, now)} unread={view.unread} />
            ))}
          </div>
        ))}
      </div>
    </Pop>
  );
}
