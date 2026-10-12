// Image viewer (design: Lightbox): full screen over everything, one for
// every image of the console. The top bar — the name, the details, Download,
// Open in a new tab, Close; the image fitted to the stage; ←/→ and the
// arrows step through the images of one message ("1 of 2"), Escape closes.
// Rendered through an Overlay (a portal into document.body): the page under
// it is inert, the focus stays inside and comes back on close. The natural
// size of the image joins the details once it has loaded (onSize).

import { useEffect } from 'react';
import { IconBtn } from '../IconBtn/IconBtn.tsx';
import { Overlay } from '../Overlay/Overlay.tsx';
import './Lightbox.css';

export type LightboxProps = {
  src: string;
  name: string;
  meta: string;
  // The bytes as a download (null — none).
  download: string | null;
  // "1 of 2" among the images of one message; null — a single image.
  count: string | null;
  onStep: (by: number) => void;
  onClose: () => void;
  onSize?: (size: { width: number; height: number }) => void;
};

export function Lightbox({ src, name, meta, download, count, onStep, onClose, onSize }: LightboxProps) {
  useEffect(() => {
    if (count === null) {
      return undefined;
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        onStep(event.key === 'ArrowLeft' ? -1 : 1);
      }
    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [count, onStep]);

  return (
    <Overlay onClose={onClose}>
      <div className="lbox" role="dialog" aria-modal="true" aria-label={name} tabIndex={-1}>
        <div className="lbox-bar">
          <div className="lbox-t">
            <span className="lbox-n">{name}</span>
            {meta ? <span className="lbox-m">{meta}</span> : null}
          </div>
          <span className="lbox-acts">
            {download ? <IconBtn icon="download" label="Download" href={download} /> : null}
            <IconBtn icon="external-link" label="Open in a new tab" href={src} external />
            <IconBtn icon="x" label="Close" onClick={onClose} />
          </span>
        </div>
        <div
          className="lbox-stage"
          onClick={event => {
            if (event.target === event.currentTarget) {
              onClose();
            }
          }}
        >
          <img key={src} src={src} alt={name} onLoad={event => onSize?.({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
          {count !== null ? (
            <>
              <IconBtn icon="chevron-left" label="Previous image" variant="regular" className="lbox-prev" onClick={() => onStep(-1)} />
              <IconBtn icon="chevron-right" label="Next image" variant="regular" className="lbox-next" onClick={() => onStep(1)} />
              <span className="lbox-count">{count}</span>
            </>
          ) : null}
        </div>
      </div>
    </Overlay>
  );
}
