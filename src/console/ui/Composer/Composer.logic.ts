// The composer's keys: ⌘↵ (Ctrl+↵ outside macOS) sends, Enter alone is a
// new line — a message to an agent is often several paragraphs.

export type SendKey = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
};

export function isSendKey(event: SendKey): boolean {
  return (
    event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && !event.isComposing
  );
}

// What to send: the text without the surrounding blank lines — only whole
// blank lines go, the indentation of the first line stays (a pasted code
// block or an indented Markdown line keeps its meaning); empty means
// nothing to send.
export function outgoingText(value: string): string {
  return value.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd();
}
