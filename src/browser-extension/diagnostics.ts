// What went wrong inside the extension and nobody would otherwise see: the
// console of a service worker stays on the user's machine. The link sends
// the reports to the server while it is connected; before that they wait
// here, a few of them.

const KEPT = 50;

const waiting: string[] = [];
let sink: ((text: string) => void) | undefined;

export function report(text: string): void {
  console.warn(`[browser-link] ${text}`);

  if (sink) {
    sink(text);
  } else if (waiting.push(text) > KEPT) {
    waiting.shift();
  }
}

// The link names where the reports go; undefined while it is down.
export function setReportSink(next: ((text: string) => void) | undefined): void {
  sink = next;

  if (next) {
    for (const text of waiting.splice(0)) {
      next(text);
    }
  }
}
