/**
 * HTTP server (node:http, no framework).
 *
 *   GET  /healthz          liveness only: {"status":"ok"} (no mode, no platforms, no secrets)
 *   POST /webhooks/stripe  Stripe endpoint: raw body, Stripe-Signature verified offline
 *   POST /events           OpenArt backend -> signup, activation, checkout, leads (HMAC-signed)
 *   GET  /value            OpenArt backend (HMAC over "GET <path>?<query>"): the value decided for a
 *                          purchase, so the browser pixel sends the SAME value as the server
 *   POST /pubsub/stripe    alternative: their existing Stripe handler publishes the raw event to
 *                          Pub/Sub; push subscription with OIDC, Stripe signature re-checked
 *   POST /tasks/drain      Cloud Scheduler (OIDC) or HMAC: sweep parked events + drain the outbox
 *   POST /tasks/erase      OIDC (scheduler service account) or HMAC: erase a user (right to erasure)
 *
 * Every request runs inside one try/catch, URL parsing included, and the handler promise is always
 * caught: a malformed request line (GET ///, //[) is a 400, never an unhandled rejection that would
 * take the process down. Responses never echo secrets, PII or stack traces. shutdown() stops
 * accepting, waits for in-flight requests and the background drain, then resolves.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { App } from './app.js';
import type { PurchaseValueInput } from './adapters/value-resolver.js';
import { valueInputOf } from './adapters/value-resolver.js';
import { INTERNAL_SIGNATURE_HEADER, verifyInternalSignature } from './http/internal-auth.js';
import { verifyPushToken } from './http/oidc.js';
import { verifyStripeWebhook } from './http/stripe-verify.js';
import { parseInternalEventsBody } from './ingest/internal-events.js';
import { validateSource } from './ingest/source-schemas.js';
import type { StripeEvent } from './ingest/stripe-types.js';
import type { DrainReport } from './outbox/drainer.js';
import { RETENTION, expireAt } from './retention.js';
import { DAY_MS } from './time.js';
import { DEAD_LETTERS } from './pipeline/pipeline.js';
import type { IngestResult, SweepReport } from './pipeline/pipeline.js';

export const SUPPORTED_STRIPE_EVENTS: ReadonlySet<string> = new Set([
  'checkout.session.completed',
  'invoice.paid',
  'invoice_payment.paid',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'charge.refunded',
  'charge.dispute.created',
]);

/** GET /value waits at most this long for a purchase row or a purchase-time score. */
export const VALUE_MAX_WAIT_MS = 3_000;
const VALUE_POLL_MS = 200;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function send(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'payload_too_large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new HttpError(413, 'payload_too_large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function requireJson(req: IncomingMessage): void {
  const type = String(req.headers['content-type'] ?? '');
  if (!/^application\/json\b/i.test(type)) throw new HttpError(415, 'unsupported_media_type');
}

function parseJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** The request path and query. Throws a 400 (inside the handler's try) for an unparseable target. */
function requestTarget(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://internal');
  } catch {
    throw new HttpError(400, 'bad_request');
  }
}

function summarize(result: IngestResult): Record<string, unknown> {
  return { source_key: result.source_key, status: result.status, ...(result.reason ? { reason: result.reason } : {}), event_ids: result.event_ids, outbox: result.outbox };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

const EraseBodySchema = z
  .strictObject({
    user_id: z.string().min(1).max(128).regex(/^\S+$/).optional(),
    hubspot_contact_id: z.string().regex(/^\d{1,32}$/).optional(),
  })
  .refine((b) => b.user_id !== undefined || b.hubspot_contact_id !== undefined, 'user_id or hubspot_contact_id');

export interface ServerHandle {
  server: Server;
  /** Resolves when any background drain has finished (tests, graceful shutdown). */
  idle(): Promise<void>;
  handler(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Stop accepting, wait (at most timeoutMs) for in-flight requests and the background drain, then close. */
  shutdown(timeoutMs: number): Promise<void>;
}

export function createHttpServer(app: App): ServerHandle {
  const { config, clock, log, store } = app.deps;
  let draining: Promise<unknown> | null = null;
  let rerun = false;
  let closing = false;
  const inflight = new Set<Promise<void>>();

  const drainInBackground = () => {
    if (draining) {
      rerun = true;
      return;
    }
    draining = (async () => {
      do {
        rerun = false;
        try {
          await app.pipeline.drain();
        } catch (err) {
          log.error('drain.failed', { error: (err as Error).message });
        }
      } while (rerun && !closing);
    })().finally(() => {
      draining = null;
    });
  };

  const idle = async () => {
    while (draining) await draining;
  };

  const afterIngest = async (): Promise<DrainReport | null> => {
    if (config.drainAfterIngest === 'sync') return app.pipeline.drain();
    if (config.drainAfterIngest === 'async' && !closing) drainInBackground();
    return null;
  };

  /** Shared by the webhook and Pub/Sub paths once the event is authenticated. */
  const ingestStripeEvent = async (event: StripeEvent): Promise<{ status: number; body: Record<string, unknown> }> => {
    if (!SUPPORTED_STRIPE_EVENTS.has(event.type)) return { status: 200, body: { received: true, status: 'ignored', reason: 'unsupported_event_type' } };
    if (config.stripe.livemode !== 'any' && event.livemode !== (config.stripe.livemode === 'live')) {
      // A test-mode purchase must never reach an ad platform (and a live one never a test setup).
      log.warn('stripe.livemode_mismatch', { event_id: event.id, livemode: event.livemode, expected: config.stripe.livemode });
      return { status: 200, body: { received: true, status: 'ignored', reason: 'stripe_livemode_mismatch' } };
    }
    const schema = validateSource('stripeEvent', event);
    if (!schema.valid) {
      // A signed but incompatible payload (e.g. an unexpected API version): retries cannot fix it.
      await store.put(DEAD_LETTERS, `stripe:${event.id}|schema`, {
        source_key: `stripe:${event.id}`,
        reason: 'stripe_event_schema_invalid',
        errors: schema.errors,
        user_id: typeof (event.data.object as { customer?: unknown }).customer === 'string' ? (event.data.object as { customer: string }).customer : null,
        at_ms: clock(),
        expire_at: expireAt(clock(), RETENTION.deadLetterDays),
      });
      log.error('stripe.schema_invalid', { event_id: event.id, type: event.type, errors: schema.errors });
      return { status: 200, body: { received: true, status: 'dead_lettered', reason: 'stripe_event_schema_invalid' } };
    }
    const result = await app.pipeline.ingestStripe(event);
    if (result.status === 'in_progress') return { status: 409, body: { error: 'in_progress' } };
    const drained = await afterIngest();
    return { status: 200, body: { received: true, ...summarize(result), ...(drained ? { drain: drained } : {}) } };
  };

  const authorizeOidcOrHmac = async (req: IncomingMessage, signed: Buffer, allowed: Array<string | null>): Promise<void> => {
    const emails = allowed.filter((e): e is string => typeof e === 'string');
    if (config.oidc && app.deps.idTokenVerifier && emails.length > 0 && header(req, 'authorization')) {
      const auth = await verifyPushToken(header(req, 'authorization'), { audience: config.oidc.audience, allowedEmails: emails }, app.deps.idTokenVerifier);
      if (auth.ok) return;
      throw new HttpError(401, auth.reason);
    }
    const hmac = verifyInternalSignature(signed, header(req, INTERNAL_SIGNATURE_HEADER), config.internalAuth.hmacSecrets, config.internalAuth.toleranceSeconds, clock());
    if (!hmac.ok) throw new HttpError(401, hmac.reason);
  };

  /** The value decided for a purchase: waits (bounded) for the Stripe row and the purchase-time score, then fixes it. */
  const decideValue = async (eventId: string, maxWaitMs: number) => {
    const deadline = Date.now() + maxWaitMs;
    const window = () => ({ fromMs: clock() - 35 * DAY_MS, toMs: clock() + DAY_MS });
    let row = await app.deps.ledger.get(eventId, window());
    while (!row && Date.now() + VALUE_POLL_MS <= deadline) {
      await sleep(VALUE_POLL_MS);
      row = await app.deps.ledger.get(eventId, window());
    }
    const input: PurchaseValueInput | null = row ? valueInputOf(row) : null;
    if (!input) return null;
    let value = await app.values.decide(input, clock(), 'value_endpoint', { force: false });
    while (!value && Date.now() + VALUE_POLL_MS <= deadline) {
      await sleep(VALUE_POLL_MS);
      value = await app.values.decide(input, clock(), 'value_endpoint', { force: false });
    }
    // Out of time: fix the decision now (cash_fallback) so the pixel and the server agree.
    return value ?? (await app.values.decide(input, clock(), 'value_endpoint', { force: true }));
  };

  const routes: Record<string, { method: string; run: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> }> = {
    '/healthz': {
      method: 'GET',
      run: async (_req, res) => send(res, 200, { status: 'ok' }),
    },

    '/webhooks/stripe': {
      method: 'POST',
      run: async (req, res) => {
        const raw = await readBody(req, config.maxBodyBytes);
        const verified = verifyStripeWebhook(raw, header(req, 'stripe-signature'), config.stripe.webhookSecrets, config.stripe.toleranceSeconds, clock());
        if (!verified.ok) {
          log.warn('stripe.signature_rejected', { reason: verified.reason.split(':')[0] });
          throw new HttpError(400, 'invalid_signature');
        }
        const out = await ingestStripeEvent(verified.event);
        send(res, out.status, out.body);
      },
    },

    '/events': {
      method: 'POST',
      run: async (req, res) => {
        requireJson(req);
        const raw = await readBody(req, config.maxBodyBytes);
        const auth = verifyInternalSignature(raw, header(req, INTERNAL_SIGNATURE_HEADER), config.internalAuth.hmacSecrets, config.internalAuth.toleranceSeconds, clock());
        if (!auth.ok) throw new HttpError(401, auth.reason);
        const parsed = parseInternalEventsBody(parseJson(raw));
        if (!parsed.ok) return send(res, 400, { error: 'invalid_events', detail: parsed.error });
        const results: IngestResult[] = [];
        for (const env of parsed.envelopes) results.push(await app.pipeline.ingestInternal(env));
        const drained = await afterIngest();
        const conflict = results.some((r) => r.status === 'in_progress');
        send(res, conflict ? 409 : 200, { results: results.map(summarize), ...(drained ? { drain: drained } : {}) });
      },
    },

    '/value': {
      method: 'GET',
      run: async (req, res, url) => {
        // Signed like POST /events, over "GET <path>?<query>" (a GET has no body to sign).
        const auth = verifyInternalSignature(Buffer.from(`GET ${req.url ?? ''}`), header(req, INTERNAL_SIGNATURE_HEADER), config.internalAuth.hmacSecrets, config.internalAuth.toleranceSeconds, clock());
        if (!auth.ok) throw new HttpError(401, auth.reason);
        const invoiceId = url.searchParams.get('invoice_id');
        const eventIdParam = url.searchParams.get('event_id');
        let eventId: string;
        if (invoiceId !== null && /^in_[A-Za-z0-9]{1,200}$/.test(invoiceId)) eventId = `purchase_${invoiceId}`;
        else if (eventIdParam !== null && /^purchase_(in_[A-Za-z0-9]{1,200}|cs_(live|test)_[A-Za-z0-9]{1,200})$/.test(eventIdParam)) eventId = eventIdParam;
        else throw new HttpError(400, 'invoice_id_or_event_id_required');
        const waitParam = Number(url.searchParams.get('max_wait_ms') ?? '1500');
        const maxWaitMs = Number.isFinite(waitParam) ? Math.min(Math.max(0, Math.floor(waitParam)), VALUE_MAX_WAIT_MS) : 1500;
        const value = await decideValue(eventId, maxWaitMs);
        if (!value) throw new HttpError(404, 'unknown_purchase');
        send(res, 200, {
          event_id: eventId,
          invoice_id: eventId.startsWith('purchase_in_') ? eventId.slice('purchase_'.length) : null,
          value: value.value,
          currency: value.currency,
          value_basis: value.basis,
          value_floored: value.floored,
        });
      },
    },

    '/pubsub/stripe': {
      method: 'POST',
      run: async (req, res) => {
        requireJson(req);
        if (!config.oidc?.pubsubServiceAccount || !app.deps.idTokenVerifier) throw new HttpError(404, 'not_found');
        const auth = await verifyPushToken(header(req, 'authorization'), { audience: config.oidc.audience, allowedEmails: [config.oidc.pubsubServiceAccount] }, app.deps.idTokenVerifier);
        if (!auth.ok) throw new HttpError(401, auth.reason);
        const envelope = parseJson(await readBody(req, config.maxBodyBytes)) as { message?: { data?: unknown; attributes?: Record<string, string> } };
        const data = envelope.message?.data;
        if (typeof data !== 'string') throw new HttpError(400, 'invalid_push_envelope');
        const raw = Buffer.from(data, 'base64');
        let event: StripeEvent;
        if (config.pubsubRequireStripeSignature) {
          const verified = verifyStripeWebhook(raw, envelope.message?.attributes?.stripe_signature, config.stripe.webhookSecrets, config.stripe.pubsubToleranceSeconds, clock());
          if (!verified.ok) throw new HttpError(400, 'invalid_signature');
          event = verified.event;
        } else {
          event = parseJson(raw) as StripeEvent;
        }
        const out = await ingestStripeEvent(event);
        send(res, out.status, out.body);
      },
    },

    '/tasks/drain': {
      method: 'POST',
      run: async (req, res) => {
        const raw = await readBody(req, config.maxBodyBytes);
        await authorizeOidcOrHmac(req, raw, [config.oidc?.schedulerServiceAccount ?? null]);
        // A failing sweep never stops the drain: queued conversions must keep moving.
        let swept: SweepReport | null = null;
        let sweepError: string | null = null;
        try {
          swept = await app.pipeline.sweepParked();
        } catch (err) {
          sweepError = (err as Error).message;
          log.error('sweep.failed', { error: sweepError });
        }
        const report = await app.pipeline.drain();
        send(res, 200, {
          swept_parked: swept?.swept ?? 0,
          ...(swept ? { sweep_failed: swept.failed, sweep_dead_lettered: swept.dead_lettered } : {}),
          ...(sweepError ? { sweep_error: sweepError } : {}),
          drain: report,
        });
      },
    },

    '/tasks/erase': {
      method: 'POST',
      run: async (req, res) => {
        requireJson(req);
        const raw = await readBody(req, config.maxBodyBytes);
        await authorizeOidcOrHmac(req, raw, [config.oidc?.schedulerServiceAccount ?? null]);
        const body = EraseBodySchema.safeParse(parseJson(raw));
        if (!body.success) throw new HttpError(400, 'invalid_erasure_request');
        const report = await app.eraser.erase({
          ...(body.data.user_id ? { user_id: body.data.user_id } : {}),
          ...(body.data.hubspot_contact_id ? { hubspot_contact_id: body.data.hubspot_contact_id } : {}),
        });
        send(res, 200, report);
      },
    },
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let path = '(unparsed)';
    try {
      if (closing) {
        send(res, 503, { error: 'shutting_down' }, { Connection: 'close' });
        return;
      }
      const url = requestTarget(req);
      path = url.pathname;
      const route = routes[path];
      if (!route) throw new HttpError(404, 'not_found');
      if (req.method !== route.method) {
        send(res, 405, { error: 'method_not_allowed' }, { Allow: route.method });
        return;
      }
      await route.run(req, res, url);
    } catch (err) {
      if (err instanceof HttpError) {
        if (!res.headersSent) send(res, err.status, { error: err.code });
        return;
      }
      log.error('http.unhandled', { path, error: (err as Error).message });
      if (!res.headersSent) send(res, 500, { error: 'internal_error' });
    }
  };

  const server = createServer((req, res) => {
    const task = handler(req, res)
      .catch((err: unknown) => {
        // Last line of defence: nothing a request does may become an unhandled rejection.
        log.error('http.handler_crashed', { error: (err as Error)?.message ?? String(err) });
        if (!res.headersSent) send(res, 500, { error: 'internal_error' });
        else res.destroy();
      })
      .finally(() => {
        inflight.delete(task);
      });
    inflight.add(task);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  // An unparseable request line is answered by Node itself (400) without reaching the handler.
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    else socket.destroy();
  });

  const shutdown = async (timeoutMs: number): Promise<void> => {
    closing = true;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections();
    const finished = (async () => {
      await Promise.allSettled([...inflight]);
      await idle();
      server.closeIdleConnections();
      await closed;
    })();
    await Promise.race([finished, sleep(timeoutMs)]);
    server.closeAllConnections();
  };

  return { server, handler, idle, shutdown };
}
