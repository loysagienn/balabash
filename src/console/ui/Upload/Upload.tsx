// Upload panel (design: Upload, UploadItem): where the files are going and
// each file's row. While files upload, "Fold" leaves one line (folded):
// the headline ("Uploading 2 of 5"), where to, the failures and the
// progress of the whole; "Unfold" brings the rows back. "×" closes the
// panel only once nothing uploads (finished); uploads go on whatever the
// panel shows. A corner panel of the file area (the feature places it; on
// the phone above the tabs).

import type { MouseEvent, ReactNode } from 'react';
import type { IconName } from '../Icon/Icon.tsx';
import { Icon } from '../Icon/Icon.tsx';
import { IconBtn } from '../IconBtn/IconBtn.tsx';
import { Obj } from '../Obj/Obj.tsx';
import { Prog } from '../Prog/Prog.tsx';
import { Code } from '../atoms/atoms.tsx';
import './Upload.css';

export type UploadProps = {
  path: string;
  // The header before the path: "Uploading to", "Uploaded to", "Uploaded 3 of 4 to".
  title: string;
  finished: boolean;
  folded: boolean;
  // Folded: the headline, the failures ("2 failed", empty for none), the progress of the whole (%).
  count: string;
  failed: string;
  progress: number;
  onFold: (folded: boolean) => void;
  onClose: () => void;
  // A name-clash dialog is asking (the phone's sheet takes the panel's place).
  clash?: boolean;
  children: ReactNode;
  className?: string;
};

export function Upload({ path, title, finished, folded, count, failed, progress, onFold, onClose, clash, children, className }: UploadProps) {
  return (
    <div className={className ? `upl ${className}` : 'upl'} role="status" aria-label="Uploads" data-clash={clash ? '' : undefined}>
      {folded ? (
        <div className="upl-fold">
          <span className="upl-fold-t">{count}</span>
          <span className="upl-fold-s">
            to {path}
            {failed ? (
              <>
                {' · '}
                <em>{failed}</em>
              </>
            ) : null}
          </span>
          <IconBtn icon="chevron-up" label="Unfold" size="sm" onClick={() => onFold(false)} />
          <Prog value={progress} className="upl-fold-prog" label={count} />
        </div>
      ) : (
        <>
          <div className="upl-h">
            {title} <Code>{path}</Code>
            <span className="upl-h-end">
              {finished ? <IconBtn icon="x" label="Close" size="sm" onClick={onClose} /> : <IconBtn icon="chevron-down" label="Fold" size="sm" onClick={() => onFold(true)} />}
            </span>
          </div>
          <div className="upl-rows">{children}</div>
        </>
      )}
    </div>
  );
}

export type UploadItemProps = {
  icon?: IconName;
  name: string;
  // "1.3 of 2.1 MiB", "waiting", the size when done, the reason of a failure.
  status: string;
  // Running with a bar; undefined while waiting (no bar).
  progress?: number;
  state?: 'done' | 'err';
  // err: false when retrying can't help (Larger than 2 GB).
  retry?: boolean;
  // done: the file as placed (the name opens it).
  href?: string;
  onOpen?: (event: MouseEvent<HTMLAnchorElement>) => void;
  onRetry?: () => void;
  // Running — cancel; failed — remove.
  onRemove?: () => void;
};

export function UploadItem({ icon = 'file-text', name, status, progress, state, retry = true, href, onOpen, onRetry, onRemove }: UploadItemProps) {
  return (
    <div className="upl-i" data-state={state}>
      <Obj icon={icon} size="sm" className="upl-ic" />
      {state === 'done' && href ? (
        <a className="upl-n" href={href} title={name} onClick={onOpen}>
          {name}
        </a>
      ) : (
        <b className="upl-n" title={name}>
          {name}
        </b>
      )}
      <small className="upl-s">{status}</small>
      <span className="upl-act">
        {state === 'done' ? (
          <span className="upl-ok">
            <Icon name="check" aria-label="Uploaded" role="img" />
          </span>
        ) : (
          <>
            {state === 'err' && retry && onRetry ? <IconBtn icon="rotate-ccw" label={`Retry ${name}`} size="sm" onClick={onRetry} /> : null}
            {onRemove ? <IconBtn icon="x" label={state === 'err' ? `Remove ${name}` : `Cancel upload of ${name}`} size="sm" onClick={onRemove} /> : null}
          </>
        )}
      </span>
      {progress !== undefined && state !== 'err' && state !== 'done' ? <Prog value={progress} className="upl-prog" label={`${name}: ${status}`} /> : null}
    </div>
  );
}
