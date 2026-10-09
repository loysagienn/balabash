// The last net under the React tree: an error thrown while rendering (a
// bad event shape the projection did not expect, a component's own bug)
// would otherwise unmount the whole console into a blank page. Here it
// becomes the Crashed card with the error's words; the store, the stream
// and the history keep running underneath — a reload starts them over.
// A class, since React gives the catch only to one.

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Crashed } from '../screens/outside/Crashed.tsx';

type Props = { children: ReactNode };
type State = { error: Error | null };

// The words of an error for the card: its message, or the type when it
// has none; a thrown non-Error — its text.
export function errorWords(error: unknown): string {
  if (error instanceof Error) {
    return error.message.trim() || error.name;
  }

  return String(error);
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(errorWords(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // React reports the error itself; the component stack is the part it
    // does not, and the one that says where.
    console.error('console: render failed', error, info.componentStack);
  }

  override render(): ReactNode {
    return this.state.error ? <Crashed message={errorWords(this.state.error)} /> : this.props.children;
  }
}
