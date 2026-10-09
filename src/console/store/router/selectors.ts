import type { State } from '../types.ts';

export const selectRoute = (state: State) => state.router.route;
