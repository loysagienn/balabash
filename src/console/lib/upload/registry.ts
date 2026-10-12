// What an upload holds that is not data: the picked File (the bytes a retry
// sends again) and the AbortController of the request in flight. The store
// keeps the facts of each upload — its id, name, size, progress, outcome
// (store/attachments, store/uploads); the things behind an id live here,
// for the tab's lifetime, and go once the upload is removed. Ids are random
// (crypto.randomUUID), so two stores of one process (tests) never share one.

const files = new Map<string, File>();
const transfers = new Map<string, AbortController>();

// Keeps a picked file; the id names it in the store's actions.
export function keepFile(file: File): string {
  const id = crypto.randomUUID();

  files.set(id, file);

  return id;
}

export function fileOf(id: string): File | null {
  return files.get(id) ?? null;
}

// A new request for the upload: the controller that cancels it (a request
// still in flight under the same id is cancelled first).
export function startTransfer(id: string): AbortController {
  transfers.get(id)?.abort();

  const controller = new AbortController();

  transfers.set(id, controller);

  return controller;
}

// The request is over (done or failed): its controller is no longer needed.
export function endTransfer(id: string, controller: AbortController): void {
  if (transfers.get(id) === controller) {
    transfers.delete(id);
  }
}

// Cancels the request in flight, if any.
export function cancelTransfer(id: string): void {
  transfers.get(id)?.abort();
  transfers.delete(id);
}

// The upload is gone (removed, sent, cancelled): the request is cut off and
// the file let go.
export function forget(id: string): void {
  cancelTransfer(id);
  files.delete(id);
}
