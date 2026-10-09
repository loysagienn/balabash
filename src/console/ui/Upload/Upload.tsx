// Upload panel (design: Upload, UploadItem): where the files are going and
// each file's progress — done, in progress (progress) or an error (state
// "err"); the rest keep uploading. A corner panel on the file screen (the
// screen places it); "Hide" closes it.

import type { ReactNode } from 'react';
import type { IconName } from '../Icon/Icon.tsx';
import { IconBtn } from '../IconBtn/IconBtn.tsx';
import { Obj } from '../Obj/Obj.tsx';
import { Prog } from '../Prog/Prog.tsx';
import { Code } from '../atoms/atoms.tsx';
import './Upload.css';

export type UploadProps = {
  path: string;
  onHide?: () => void;
  children: ReactNode;
  className?: string;
};

export function Upload({ path, onHide, children, className }: UploadProps) {
  return (
    <div className={className ? `upl ${className}` : 'upl'} role="status">
      <div className="upl-h">
        Uploading to <Code>{path}</Code>
        {onHide ? (
          <span className="upl-h-end">
            <IconBtn icon="x" label="Hide" size="sm" onClick={onHide} />
          </span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export type UploadItemProps = {
  icon?: IconName;
  name: string;
  // "1.3 of 2.1 MB", "done", "over 100 MB".
  status: string;
  progress?: number;
  state?: 'done' | 'err';
};

export function UploadItem({ icon = 'file-text', name, status, progress, state }: UploadItemProps) {
  return (
    <div className="upl-i" data-state={state}>
      <Obj icon={icon} size="sm" className="upl-ic" />
      <b className="upl-n">{name}</b>
      <small className="upl-s">{status}</small>
      {progress !== undefined ? <Prog value={progress} state={state === 'err' ? 'err' : undefined} className="upl-prog" label={`${name}: ${status}`} /> : null}
    </div>
  );
}
