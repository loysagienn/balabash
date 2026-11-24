// The stream's `browsers` frame: the list of linked browsers this user sees
// from this workspace changed somewhere — a browser came or went, was
// paired, renamed, enabled, disabled or disconnected.
export const browsersChangedRemotely = () => ({ type: 'BROWSERS_CHANGED_REMOTELY' }) as const;

// The owner's switch of a browser in this workspace: on or off, at once.
// `call` is the switch as the store held it when the command went out — an
// answer is applied only while the store still holds that one.
export type BrowserSwitch = { on: boolean; settled: boolean };

export const setBrowserHere = (id: string, name: string, on: boolean) => ({ type: 'SET_BROWSER_HERE', id, name, on }) as const;
export const setBrowserHereDone = (id: string, call: BrowserSwitch) => ({ type: 'SET_BROWSER_HERE_DONE', id, call }) as const;
export const setBrowserHereFail = (id: string, call: BrowserSwitch) => ({ type: 'SET_BROWSER_HERE_FAIL', id, call }) as const;
// The screen has a list read after the switches settled: it says what they
// said, and they are forgotten.
export const browsersRead = () => ({ type: 'BROWSERS_READ' }) as const;
