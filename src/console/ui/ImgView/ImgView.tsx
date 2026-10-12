// Image preview (design: .imgview): the picture centered in a framed box,
// scaled to fit. onSize reports the natural size once the image has loaded
// (the preview header shows "1440 × 1129"); onError — that the bytes did
// not load (the owner shows the failure, a bare <img> would not); onOpen —
// the frame opens the image viewer.

import './ImgView.css';

export type ImgViewProps = {
  src: string;
  alt: string;
  onSize?: (size: { width: number; height: number }) => void;
  onError?: () => void;
  // The picture opens full screen (the image viewer): the frame is a link
  // to the bytes, a plain click opens the viewer instead.
  onOpen?: () => void;
};

export function ImgView({ src, alt, onSize, onError, onOpen }: ImgViewProps) {
  const image = <img src={src} alt={alt} onLoad={event => onSize?.({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={onError} />;

  return onOpen ? (
    <a
      className="imgview"
      href={src}
      aria-label="Open full screen"
      onClick={event => {
        if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      {image}
    </a>
  ) : (
    <div className="imgview">{image}</div>
  );
}
