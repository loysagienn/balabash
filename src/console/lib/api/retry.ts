// The retry rule of the second data layer (TanStack Query over the Api):
// one more try after a network or server failure, none after a client
// error — a 404 is an answer, a 400 will not change.

import { ApiError } from './fetch.ts';

export function retryUnlessClient(count: number, error: Error): boolean {
  return count < 1 && !(error instanceof ApiError && error.status >= 400 && error.status < 500);
}
