// The composer's keys: Enter sends; Shift+Enter, ⌘↵ and Ctrl+↵ break the
// line. Shift+Enter is the textarea's own new line; ⌘↵ / Ctrl+↵ insert
// nothing by themselves, so the composer inserts the break. On a phone
// (no hardware keyboard, no Shift+Enter) Enter stays a new line and the
// button sends. Enter that finishes an IME composition is the
// composition's, not a send (Safari reports it with keyCode 229).

export type ComposerKeyEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
};

// 'send' — send the message; 'newline' — insert a line break by hand;
// null — leave the key to the textarea.
export type ComposerKeyAction = 'send' | 'newline' | null;

export function composerKeyAction(event: ComposerKeyEvent, phone: boolean): ComposerKeyAction {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || event.altKey || phone) {
    return null;
  }

  if (event.shiftKey) {
    return null;
  }

  if (event.metaKey || event.ctrlKey) {
    return 'newline';
  }

  return 'send';
}

// What to send: the text without the surrounding blank lines — only whole
// blank lines go, the indentation of the first line stays (a pasted code
// block or an indented Markdown line keeps its meaning); empty means
// nothing to send.
export function outgoingText(value: string): string {
  return value.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd();
}

// The box is the field: a tap anywhere on it that is not a control of its
// own — the padding, the row under the text, the ↵ hint, the gap between
// the buttons — focuses the textarea (on a phone the text sits at the top
// of the box and the row of buttons below is a dead strip otherwise —
// Vladimir, 2026-10-16). The controls keep their taps: the buttons, the
// attachment chips (their own buttons inside), and the textarea itself
// (the caret goes where the finger is). `target` is the element under the
// pointer; the match walks up to the box.
export const COMPOSER_CONTROLS = 'button, a, input, textarea, [role="button"], .composer-atts';

export type ClickTarget = { closest(selectors: string): unknown };

export function focusesField(target: ClickTarget | null): boolean {
  return target !== null && target.closest(COMPOSER_CONTROLS) === null;
}

// The buttons take the focus as any button does — "Attach" included: with
// the field kept focused through the picker, iOS moves the keyboard and the
// page unpredictably around the system sheet (tried, 2026-10-16).
