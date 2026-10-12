// The one image viewer of the console (design: Lightbox, rule 23): the
// store's ui.viewer — the images and the one shown — opened by whoever
// shows an image (a feed's or a summary's attachment, a draft chip, an
// image of the file area); navigation closes it. The details line is what
// the opener knew (size, who sent it where, when) and, once the image has
// loaded, its natural size.

import { useCallback, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { closeViewer, stepViewer } from '../../store/ui/actions.ts';
import { selectViewer } from '../../store/ui/selectors.ts';
import { Lightbox } from '../../ui/Lightbox/Lightbox.tsx';
import { viewerMeta } from './viewer.logic.ts';

export function ImageViewer() {
  const dispatch = useAppDispatch();
  const viewer = useAppSelector(selectViewer);
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const step = useCallback((by: number) => dispatch(stepViewer(by)), [dispatch]);
  const image = viewer ? viewer.images[viewer.index] : undefined;

  if (!viewer || !image) {
    return null;
  }

  const count = viewer.images.length > 1 ? `${viewer.index + 1} of ${viewer.images.length}` : null;

  return (
    <Lightbox
      src={image.src}
      name={image.name}
      meta={viewerMeta(image.meta, sizes[image.src] ?? null)}
      download={image.download}
      count={count}
      onStep={step}
      onClose={() => dispatch(closeViewer())}
      onSize={size => setSizes(known => (known[image.src] ? known : { ...known, [image.src]: size }))}
    />
  );
}
