/**
 * @openart-signal/conversion-service public surface (for scripts and other packages).
 * The Cloud Run entry point is src/main.ts.
 */

export { createApp } from './app.js';
export type { App, AppDeps } from './app.js';
export { createHttpServer, SUPPORTED_STRIPE_EVENTS } from './server.js';
export { loadConfig, demoConfig, LIVE_CONFIRMATION, DEFAULT_EVENT_SOURCE_URLS } from './config.js';
export type { ServiceConfig } from './config.js';
export { assertLiveStorage, loadStorageConfig } from './wiring.js';
export { StripeMapper, STRIPE_STATE } from './ingest/stripe-mapper.js';
export { InternalEventMapper, parseInternalEventsBody } from './ingest/internal-events.js';
export type { InternalEventEnvelope } from './ingest/internal-events.js';
export { signInternalBody, verifyInternalSignature, INTERNAL_SIGNATURE_HEADER } from './http/internal-auth.js';
export { PLATFORM_MODULES, validateRequest } from './platforms/registry.js';
export type { PlatformModule, PlatformRequest } from './platforms/types.js';
export { DryRunTransport, LiveTransport, RoutingTransport } from './outbox/transport.js';
export { InMemoryDocumentStore } from './adapters/document-store.js';
export { FirestoreDocumentStore } from './adapters/firestore-document-store.js';
export { InMemoryLedger, FileLedger, BigQueryLedger } from './adapters/ledger.js';
export { ValueResolver, InMemoryPurchaseValues, BigQueryPurchaseValueReader, VALUE_DECISIONS, valueInputOf } from './adapters/value-resolver.js';
export type { PurchaseValueReader, PurchaseValueInput } from './adapters/value-resolver.js';
export { FixedFxRates } from './adapters/fx.js';
export type { FxRateProvider } from './adapters/fx.js';
export { Eraser } from './erasure.js';
export type { ErasureReport, ErasureRequest } from './erasure.js';
export { valueHealth } from './reports/value-health.js';
export type { ValueHealthReport } from './reports/value-health.js';
export { RETENTION } from './retention.js';
export { ClickIdResolver, InMemoryClickIdStore, BigQueryClickIdStoreReader } from './adapters/click-id-resolver.js';
export { InMemoryUserContext, BigQueryUserContextReader } from './adapters/user-context.js';
export { DEFAULT_CONSENT_POLICY, decidePlatformConsent, mergeConsentForSend, REGULATED_COUNTRIES } from './adapters/consent-resolver.js';
export type * from './types.js';
