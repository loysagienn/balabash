// A stored file as a value of the catalog: the reference, never the content.

import type { FileRefValue } from '../catalog/index.ts';
import type { FileRef as StoredFile } from '../core/contract.ts';
import { FileNotFoundError, getWorkspaceFile } from '../files/index.ts';

export function fileRefValue(file: StoredFile): FileRefValue {
  return {
    kind: 'file',
    id: file.id,
    name: file.originalFilename,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    width: file.width,
    height: file.height,
  };
}

// The references of the stored files with these ids, in the order given. A
// file the workspace does not have (any more) is left out: a reference
// names a file that can be taken.
export async function workspaceFileRefs(workspaceId: string, fileIds: string[]): Promise<FileRefValue[]> {
  const refs: FileRefValue[] = [];

  for (const fileId of fileIds) {
    try {
      refs.push(fileRefValue(await getWorkspaceFile(workspaceId, fileId)));
    } catch (error) {
      if (!(error instanceof FileNotFoundError)) {
        throw error;
      }
    }
  }

  return refs;
}
