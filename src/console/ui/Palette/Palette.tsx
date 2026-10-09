// ⌘K search palette (design: .pal, PaletteItem): the input on top, grouped
// results as a listbox, a footer with the keys. The `pal` container hides
// the secondary columns (meta, right side, wide keys) when narrower than
// 520 px — on the phone the same palette is full screen. PaletteItem is a
// thread (agent), a file (icon, path — monospace) or a project (icon): the
// match is highlighted, on the right a state (endState) or details (end)
// and the key hint of the selected row. The input is controlled; moving the
// selection with the arrows, opening with ↵ and where the palette floats
// are the feature's business (stage 7).

import type { ChangeEvent, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { Avatar } from '../Avatar/Avatar.tsx';
import { Icon } from '../Icon/Icon.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import { Obj } from '../Obj/Obj.tsx';
import { Status } from '../Status/Status.tsx';
import { Kbd } from '../atoms/atoms.tsx';
import { highlightParts } from '../atoms/highlight.ts';
import type { StateName } from '../atoms/state.ts';
import './Palette.css';

export function Palette({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={className ? `pal ${className}` : 'pal'} role="dialog" aria-label="Search">
      {children}
    </div>
  );
}

export type PaletteInputProps = {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  placeholder?: string;
  // The id of the listbox and of the selected option (aria).
  listId?: string;
  activeId?: string;
  autoFocus?: boolean;
};

export function PaletteInput({ value, onChange, onKeyDown, placeholder = 'Search threads, projects and files', listId, activeId, autoFocus }: PaletteInputProps) {
  return (
    <div className="pal-in">
      <Icon name="search" />
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        role={listId ? 'combobox' : undefined}
        aria-controls={listId}
        aria-expanded={listId ? true : undefined}
        aria-activedescendant={activeId}
        aria-autocomplete={listId ? 'list' : undefined}
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <span className="pal-in-end">
        <Kbd>esc</Kbd>
      </span>
    </div>
  );
}

export function PaletteList({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <div className="pal-list" role="listbox" id={id}>
      {children}
    </div>
  );
}

export function PaletteGroup({ children }: { children: ReactNode }) {
  return <div className="pal-g">{children}</div>;
}

export type PaletteItemProps = {
  id?: string;
  // A thread row shows the agent's avatar; otherwise an object icon.
  agent?: string;
  icon?: IconName;
  text: string;
  hit?: string;
  meta?: string;
  // The right side: a state with its label, or plain details.
  endState?: StateName;
  end?: string;
  // The key hint of the selected row ("↵").
  kbd?: string;
  sel?: boolean;
  // A file path — monospace.
  path?: boolean;
  onClick?: (event: MouseEvent<HTMLDivElement>) => void;
  onPointerMove?: (event: MouseEvent<HTMLDivElement>) => void;
};

export function PaletteItem({ id, agent, icon, text, hit, meta, endState, end, kbd, sel, path, onClick, onPointerMove }: PaletteItemProps) {
  return (
    <div className="pal-i" role="option" id={id} aria-selected={sel ? 'true' : 'false'} onClick={onClick} onPointerMove={onPointerMove}>
      {agent ? <Avatar agent={agent} size="sm" /> : <Obj icon={icon ?? 'file-text'} size="sm" />}
      <span className="pal-i-t" data-variant={path ? 'path' : undefined}>
        {highlightParts(text, hit).map((part, i) => (part.hit ? <mark key={i}>{part.text}</mark> : part.text))}
        {meta ? <span className="pal-i-m"> · {meta}</span> : null}
      </span>
      <span className="pal-i-end">
        {endState ? <Status state={endState} label={end} /> : end}
        {kbd ? <Kbd>{kbd}</Kbd> : null}
      </span>
    </div>
  );
}

export function PaletteFoot({ children }: { children: ReactNode }) {
  return <div className="pal-f">{children}</div>;
}

// One key hint of the footer: keys and what they do; wide — hidden in a
// narrow palette.
export function PaletteKey({ keys, children, wide }: { keys: string[]; children: ReactNode; wide?: boolean }) {
  return (
    <span className="pal-f-i" data-wide={wide ? '' : undefined}>
      {keys.map(key => (
        <Kbd key={key}>{key}</Kbd>
      ))}
      {children}
    </span>
  );
}
