// The six object states of the design (README, rule 4) and the icon a
// badge or a compact status shows for the settled ones; the live states
// (run · wait · act) get a dot instead.

export type StateName = 'run' | 'wait' | 'act' | 'done' | 'err' | 'off';

export const STATE_ICON = { done: 'check', err: 'circle-alert', off: 'circle-slash' } as const;

export type StateIconName = (typeof STATE_ICON)[keyof typeof STATE_ICON];

export function stateIcon(state: StateName): StateIconName | undefined {
  return state in STATE_ICON ? STATE_ICON[state as keyof typeof STATE_ICON] : undefined;
}
