// Types for `env` from "cloudflare:workers" inside the workerd test pool.
declare namespace Cloudflare {
  interface Env {
    ATTRIBUTION_SECRET: string;
    ATTRIBUTION_SECRET_PREVIOUS?: string;
    ATTRIBUTION_KV: KVNamespace;
    ORIGIN_OVERRIDE?: string;
  }
}
