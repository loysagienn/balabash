// PDF preview: the browser's own viewer in a frame that fills the preview
// body (the file streams inline from /files/<rel>).

import './PdfView.css';

export function PdfView({ src, title }: { src: string; title: string }) {
  return <iframe className="pdfview" src={src} title={title} />;
}
