/**
 * Process-level safety net. Every request handler already catches its own errors (server.ts); a
 * promise rejection that still escapes (a background task, a library callback) is logged as
 * CRITICAL instead of letting Node 22's default --unhandled-rejections=throw kill the service and
 * every request in flight on it.
 */

import type { Logger } from './log.js';

export function installProcessHandlers(proc: Pick<NodeJS.Process, 'on'>, log: Logger): void {
  proc.on('unhandledRejection', (reason: unknown) => {
    const error = reason instanceof Error ? reason.message : String(reason);
    log.error('process.unhandled_rejection', { error });
  });
}
