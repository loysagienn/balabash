// Draft attachment in the composer (design: AttDraft): an image's preview
// (opens the image viewer) or the type icon, the name, the status — the
// progress while uploading ("1.3 of 2.1 MiB"), the size when done, the
// reason of a failure — and the upload bar along the bottom edge. state:
// undefined — uploading (× cancels the request) · done (× removes it from
// the draft; the stored file stays) · err (Retry unless retry is false —
// over 2 GB, not accepted — and ×, Remove).

import type { IconName } from '../Icon/Icon.tsx';
import { IconBtn } from '../IconBtn/IconBtn.tsx';
import { Obj } from '../Obj/Obj.tsx';
import { Prog } from '../Prog/Prog.tsx';
import './AttDraft.css';

export type AttDraftProps = {
  name: string;
  // An image with its preview, or a file with its type icon.
  preview?: string | null;
  icon?: IconName;
  status: string;
  progress?: number;
  state?: 'done' | 'err';
  retry?: boolean;
  onOpen?: () => void;
  onRetry?: () => void;
  onRemove: () => void;
};

export function AttDraft({ name, preview, icon = 'file-text', status, progress, state, retry = true, onOpen, onRetry, onRemove }: AttDraftProps) {
  return (
    <div className="attd" data-state={state} data-kind={preview ? 'img' : undefined} title={name}>
      {preview ? (
        <button type="button" className="attd-th" aria-label={`Open ${name}`} onClick={onOpen}>
          <img src={preview} alt="" />
        </button>
      ) : (
        <Obj icon={icon} size="sm" state={state === 'err' ? 'err' : undefined} className="attd-ic" />
      )}
      <span className="attd-main">
        <span className="attd-n">{name}</span>
        <span className="attd-s" role={state === 'err' ? 'alert' : undefined}>
          {status}
        </span>
      </span>
      <span className="attd-acts">
        {state === 'err' && retry && onRetry ? <IconBtn icon="rotate-ccw" label="Retry" size="sm" onClick={onRetry} /> : null}
        <IconBtn icon="x" label={state ? `Remove ${name}` : `Cancel upload of ${name}`} size="sm" onClick={onRemove} />
      </span>
      {!state && progress !== undefined ? <Prog value={progress} className="attd-prog" label={`${name}: ${status}`} /> : null}
    </div>
  );
}
