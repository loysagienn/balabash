import type { AppListingView } from '../../../api/contract.ts';
import type { Action } from '../types.ts';

export type AppsState = { items: AppListingView[]; publicAppsBase: string };

export function appsReducer(state: AppsState = { items: [], publicAppsBase: '' }, action: Action): AppsState {
  switch (action.type) {
    case 'SNAPSHOT_LOAD_DONE':
      return { items: action.snapshot.apps.apps, publicAppsBase: action.snapshot.apps.publicAppsBase };
    default:
      return state;
  }
}
