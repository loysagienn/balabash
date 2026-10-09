// The editor's keys: ⌘S (Ctrl+S outside macOS) saves instead of the
// browser's "save page".

export type SaveKey = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
};

export function isSaveKey(event: SaveKey): boolean {
  return (event.key === 's' || event.key === 'S') && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && !event.isComposing;
}
