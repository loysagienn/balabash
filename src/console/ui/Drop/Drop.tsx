// Drop zone (design: Drop): a frame while files are dragged — over the
// whole file area, where they land (the folder's path), or over the thread,
// where they attach to the draft (label: "Drop to attach to your
// message"); sub — how many. Absolute inside its owner (.fa and .th-main
// are position: relative); `place` pins it to the part of the owner in
// view instead — a thread's column is as tall as its feed, and the frame
// belongs where the eye is (Drop.css: .drop[data-place]).

import type { CSSProperties } from 'react';
import { Icon } from '../Icon/Icon.tsx';
import { Code } from '../atoms/atoms.tsx';
import './Drop.css';

export type DropPlace = { top: number; left: number; width: number; height: number };

export type DropProps = { path?: string; label?: string; sub?: string; place?: DropPlace };

export function Drop({ path, label, sub, place }: DropProps) {
  const style = place
    ? ({ '--drop-top': `${place.top}px`, '--drop-left': `${place.left}px`, '--drop-w': `${place.width}px`, '--drop-h': `${place.height}px` } as CSSProperties)
    : undefined;

  return (
    <div className="drop" data-place={place ? '' : undefined} style={style} aria-hidden="true">
      <Icon name={label ? 'paperclip' : 'upload-cloud'} />
      {label ? (
        <span>{label}</span>
      ) : (
        <span>
          Drop to upload to <Code>{path ?? ''}</Code>
        </span>
      )}
      {sub ? <small className="drop-sub">{sub}</small> : null}
    </div>
  );
}
