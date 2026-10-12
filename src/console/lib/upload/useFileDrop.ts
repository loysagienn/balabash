// Files dragged over an element (the thread's column, the file area): the
// drag handlers to put on it and the drag in progress — how many files are
// over it (the browser tells the count while dragging, not the names or
// the sizes: those come with the drop). Only a drag that carries files
// counts (text or a link dragged inside the page does not); the enter/leave
// pairs of the children are counted so the frame does not flicker; the
// drop hands the files over. `enabled` false — the element takes nothing.

import { useCallback, useRef, useState } from 'react';
import type { DragEvent } from 'react';

export type FileDrag = { count: number } | null;

export type FileDropHandlers = {
  onDragEnter: (event: DragEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
};

function carriesFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}

function fileCount(event: DragEvent<HTMLElement>): number {
  return Array.from(event.dataTransfer.items).filter(item => item.kind === 'file').length;
}

export function useFileDrop(enabled: boolean, onFiles: (files: File[]) => void): { drag: FileDrag; handlers: FileDropHandlers } {
  const [drag, setDrag] = useState<FileDrag>(null);
  const depth = useRef(0);
  const take = useRef(onFiles);

  take.current = onFiles;

  const onDragEnter = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!enabled || !carriesFiles(event)) {
        return;
      }

      event.preventDefault();
      depth.current += 1;
      setDrag({ count: fileCount(event) });
    },
    [enabled],
  );

  const onDragOver = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!enabled || !carriesFiles(event)) {
        return;
      }

      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    [enabled],
  );

  const onDragLeave = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!enabled || !carriesFiles(event)) {
        return;
      }

      depth.current = Math.max(0, depth.current - 1);

      if (depth.current === 0) {
        setDrag(null);
      }
    },
    [enabled],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!enabled || !carriesFiles(event)) {
        return;
      }

      event.preventDefault();
      depth.current = 0;
      setDrag(null);

      const files = Array.from(event.dataTransfer.files);

      if (files.length > 0) {
        take.current(files);
      }
    },
    [enabled],
  );

  return { drag: enabled ? drag : null, handlers: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
