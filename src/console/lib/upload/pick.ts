// Picked files into the upload registry: each File is kept under a new id
// (the store's actions name it by that id), an image gets an object URL for
// its preview, and a pasted image — named "image.png" by every clipboard —
// takes the minute it was pasted ("pasted-17-08.png").

import { keepFile } from './registry.ts';
import { pastedName } from './words.ts';

export type Picked = { id: string; name: string; size: number; type: string; preview: string | null };

export function pick(files: File[], { pasted = false, preview = false, at = new Date() }: { pasted?: boolean; preview?: boolean; at?: Date } = {}): Picked[] {
  return files.map(original => {
    const file = pasted && original.type.startsWith('image/') ? new File([original], pastedName(original.type, at), { type: original.type }) : original;
    const id = keepFile(file);

    return {
      id,
      name: file.name,
      size: file.size,
      type: file.type,
      preview: preview && file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
    };
  });
}
