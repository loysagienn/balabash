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
