// The six object states of the design (README, rule 4) plus paused — a
// remote thread asleep (src/remote): a form of waiting, not a seventh
// color — and the icon a badge or a compact status shows for the settled
// ones; the live states (run · wait · act · paused) get a dot instead
// (hollow for paused — the CSS of the block).

export type StateName = 'run' | 'wait' | 'act' | 'paused' | 'done' | 'err' | 'off';

export const STATE_ICON = { done: 'check', err: 'circle-alert', off: 'circle-slash' } as const;

export type StateIconName = (typeof STATE_ICON)[keyof typeof STATE_ICON];

export function stateIcon(state: StateName): StateIconName | undefined {
  return state in STATE_ICON ? STATE_ICON[state as keyof typeof STATE_ICON] : undefined;
}
