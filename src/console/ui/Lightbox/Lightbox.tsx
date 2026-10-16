// Image viewer (design: Lightbox): full screen over everything, one for
// every image of the console. The top bar — the name, the details, Download,
// Open in a new tab, Close — is the header's row, the page color at 70 %
// with a light blur: the image fits the rectangle below it and, zoomed or
// dragged, slides under it. The stage pans and zooms like a canvas (useZoom,
// zoom.logic.ts): the wheel pans, ⌘/Ctrl + wheel zooms about the cursor;
// one finger or a mouse drag pans, two fingers pinch, a double tap zooms
// into its point and back, a double tap held moves the zoom with the
// finger. ←/→ and the arrows step through the images of one message
// ("1 of 2"), Escape closes, a tap on the background closes. Rendered
// through an Overlay (a portal into document.body): the page under it is
// inert, the focus stays inside and comes back on close. The natural size
// of the image joins the details once it has loaded (onSize).

import { useEffect } from 'react';
import { IconBtn } from '../IconBtn/IconBtn.tsx';
import { Overlay } from '../Overlay/Overlay.tsx';
import './Lightbox.css';
import { useZoom } from './useZoom.ts';

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
  const zoom = useZoom(src);

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
          key={src}
          ref={zoom.stageRef}
          className="lbox-stage"
          onClick={event => {
            // The click of a clean tap on the background; a drag or a pinch that ended there is not one.
            if (event.target === event.currentTarget && zoom.consumeClick()) {
              onClose();
            }
          }}
        >
          <img ref={zoom.imgRef} src={src} alt={name} draggable={false} onLoad={event => onSize?.({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
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
