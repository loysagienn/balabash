// The sections of the shell: navigation items in order, their icons and
// routes; the phone keeps the first four as tabs and folds the rest into
// the "More" sheet.

import type { AppRoute, NavKey } from '../../lib/router/routes.ts';
import type { IconName } from '../../ui/Icon/Icon.tsx';

export type NavItem = { key: NavKey; name: string; icon: IconName; route: AppRoute };

export const NAV: NavItem[] = [
  { key: 'home', name: 'Home', icon: 'house', route: { key: 'home' } },
  { key: 'threads', name: 'Threads', icon: 'messages-square', route: { key: 'threads' } },
  { key: 'projects', name: 'Projects', icon: 'folder', route: { key: 'projects' } },
  { key: 'files', name: 'Files', icon: 'folder-tree', route: { key: 'files', path: '' } },
  { key: 'apps', name: 'Apps', icon: 'layout-grid', route: { key: 'apps' } },
  { key: 'schedule', name: 'Schedule', icon: 'calendar-clock', route: { key: 'schedule' } },
  { key: 'connections', name: 'Connections', icon: 'plug', route: { key: 'connections' } },
  { key: 'agents', name: 'Agents', icon: 'bot', route: { key: 'agents' } },
  { key: 'system', name: 'System', icon: 'activity', route: { key: 'system' } },
  { key: 'settings', name: 'Settings', icon: 'sliders-horizontal', route: { key: 'settings' } },
];

export const TAB_COUNT = 4;
export const TABS = NAV.slice(0, TAB_COUNT);
export const MORE = NAV.slice(TAB_COUNT);
