// Image preview (design: .imgview): the picture centered in a framed box,
// scaled to fit. onSize reports the natural size once the image has loaded
// (the preview header shows "1440 × 1129").

import './ImgView.css';

export type ImgViewProps = {
  src: string;
  alt: string;
  onSize?: (size: { width: number; height: number }) => void;
};

export function ImgView({ src, alt, onSize }: ImgViewProps) {
  return (
    <div className="imgview">
      <img src={src} alt={alt} onLoad={event => onSize?.({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
    </div>
  );
}
