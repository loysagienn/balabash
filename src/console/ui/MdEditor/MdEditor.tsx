// Markdown editing (design: MdEditor): the source on the left, the live
// preview (Md) on the right; when the editor is narrower than 640 px — one
// pane and an "Edit / Preview" switch (the `ed` container shows it; the
// view state lives here). The bar: the path, the "unsaved" dot (dirty),
// "Cancel" and "Save" (⌘S anywhere in the editor). Controlled: value /
// onChange — the draft is the screen's; busy — saving in flight.

import { useState } from 'react';
import { Btn } from '../Btn/Btn.tsx';
import { Md } from '../Md/Md.tsx';
import { Obj } from '../Obj/Obj.tsx';
import { Seg, SegItem } from '../Seg/Seg.tsx';
import { isSaveKey } from './MdEditor.logic.ts';
import './MdEditor.css';

export type MdEditorProps = {
  path: string;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  dirty?: boolean;
  busy?: boolean;
  autoFocus?: boolean;
  className?: string;
};

export function MdEditor({ path, value, onChange, onSave, onCancel, dirty, busy, autoFocus, className }: MdEditorProps) {
  const [view, setView] = useState<'source' | 'preview'>('source');
  const canSave = !!dirty && !busy;
  const save = () => {
    if (canSave) {
      onSave();
    }
  };

  return (
    <div
      className={className ? `ed ${className}` : 'ed'}
      data-view={view}
      onKeyDown={event => {
        if (isSaveKey(event.nativeEvent)) {
          event.preventDefault();
          save();
        }
      }}
    >
      <div className="ed-bar">
        <Obj icon="file-text" size="sm" />
        <code className="code ed-path">{path}</code>
        {dirty ? <span className="ed-dirty">unsaved</span> : null}
        <span className="ed-bar-end">
          <Seg label="Editor view" className="ed-mode">
            <SegItem label="Edit" sel={view === 'source'} onClick={() => setView('source')} />
            <SegItem label="Preview" sel={view === 'preview'} onClick={() => setView('preview')} />
          </Seg>
          <Btn label="Cancel" variant="ghost" size="sm" onClick={onCancel} />
          <Btn label="Save" variant="primary" size="sm" kbd="⌘S" busy={busy} disabled={!dirty && !busy} onClick={save} />
        </span>
      </div>
      <div className="ed-panes">
        <textarea
          className="ed-src"
          aria-label="Source"
          value={value}
          spellCheck={false}
          autoFocus={autoFocus}
          onChange={event => onChange(event.target.value)}
        />
        <div className="ed-pre">
          <Md source={value} />
        </div>
      </div>
    </div>
  );
}
