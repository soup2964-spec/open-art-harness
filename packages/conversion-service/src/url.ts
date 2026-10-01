/**
 * event_source_url hygiene. Platforms receive the page a conversion happened on, never its query
 * string or fragment: OpenArt's success URL carries uid= and session_id=, and a fragment or
 * user:password@ part could carry anything. Only https URLs are kept.
 */
export function sanitizeEventSourceUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !url.hostname) return null;
  url.search = '';
  url.hash = '';
  url.username = '';
  url.password = '';
  return url.toString();
}
