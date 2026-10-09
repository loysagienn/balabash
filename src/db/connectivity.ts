// Transient connectivity failures of the database: the server restarted
// (managed maintenance, a failover), the network dropped, the pool's socket
// was reset, a connection could not be obtained in time. A loop meets them
// by waiting and retrying the same step — unlike a genuine failure of the
// call, which is reported and skipped. Recognised by the codes Prisma and
// node put on the error chain (the driver adapter nests the socket error
// under meta.driverAdapterError, node under cause) and by the wording of
// the few messages that carry no code.

const PRISMA_CONNECTIVITY_CODES = new Set([
  'P1001', // can't reach database server
  'P1002', // reached but timed out
  'P1008', // operations timed out
  'P1017', // server has closed the connection
  'P2024', // timed out fetching a new connection from the pool
]);

const NODE_CONNECTIVITY_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

const CONNECTIVITY_MESSAGE =
  /can't reach database server|connection terminated|terminating connection|server closed the connection|connection refused|DatabaseNotReachable|SocketTimeout|the database system is (?:starting up|shutting down|in recovery)/i;

type ErrorLike = {
  code?: unknown;
  message?: unknown;
  cause?: unknown;
  meta?: unknown;
};

export function isConnectivityError(error: unknown): boolean {
  const seen = new Set<object>();
  const stack: unknown[] = [error];

  while (stack.length) {
    const current = stack.pop();

    if (!current || typeof current !== 'object' || seen.has(current)) {
      continue;
    }

    seen.add(current);

    const { code, message, cause, meta } = current as ErrorLike;

    if (typeof code === 'string' && (PRISMA_CONNECTIVITY_CODES.has(code) || NODE_CONNECTIVITY_CODES.has(code))) {
      return true;
    }

    if (typeof message === 'string' && CONNECTIVITY_MESSAGE.test(message)) {
      return true;
    }

    stack.push(cause);

    if (meta && typeof meta === 'object' && 'driverAdapterError' in meta) {
      stack.push((meta as { driverAdapterError: unknown }).driverAdapterError);
    }
  }

  return false;
}
