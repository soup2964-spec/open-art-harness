// Secret hygiene shared by the Worker (crypto.ts) and the edge-sim.
import { MIN_SECRET_LENGTH } from "./constants.js";

/** Values that must never be used as a key (documentation placeholders). */
const PLACEHOLDER_SECRETS = new Set(["replace-with-32-or-more-random-characters"]);

/** Long enough, not a known placeholder, and not trivially low-entropy (e.g. "aaaa…", "abab…"). */
export function isUsableSecret(s: unknown): s is string {
  return typeof s === "string" && s.length >= MIN_SECRET_LENGTH && !PLACEHOLDER_SECRETS.has(s) && new Set(s).size >= 12;
}
