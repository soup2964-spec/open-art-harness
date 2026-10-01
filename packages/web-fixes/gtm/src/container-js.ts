/**
 * Helpers for compiled GTM / Google tag scripts (gtm.js, /4vu8/, gtag/js): locate the
 * `var data = {…}` object and a top-level key inside it, without evaluating the script.
 */

export interface Span {
  start: number;
  /** Exclusive. */
  end: number;
}

/** Index just past the JSON value that starts at `start` ({…}, […], "…", or a scalar). */
export function scanJsonValue(text: string, start: number): number {
  const open = text[start];
  if (open === '"') {
    for (let i = start + 1; i < text.length; i += 1) {
      if (text[i] === '\\') i += 1;
      else if (text[i] === '"') return i + 1;
    }
    throw new Error('unterminated string');
  }
  if (open !== '{' && open !== '[') {
    const m = /^[^,}\]\s]+/.exec(text.slice(start));
    if (!m) throw new Error(`no JSON value at ${start}`);
    return start + m[0].length;
  }
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error('unterminated JSON value');
}

/** The `{…}` assigned to `var data = ` in a compiled GTM / Google tag script. */
export function findDataObject(js: string): Span {
  const marker = js.indexOf('var data = ');
  if (marker < 0) throw new Error('no `var data = ` in script');
  const start = js.indexOf('{', marker);
  return { start, end: scanJsonValue(js, start) };
}

export interface ContainerData {
  resource: Record<string, unknown>;
  runtime?: unknown[];
  permissions?: Record<string, unknown>;
  [key: string]: unknown;
}

export function parseContainerData(js: string): ContainerData {
  const span = findDataObject(js);
  return JSON.parse(js.slice(span.start, span.end)) as ContainerData;
}

/** Span of the value of a top-level key of the data object (e.g. "resource"). */
export function findTopLevelValue(js: string, key: string): Span {
  const data = findDataObject(js);
  let i = data.start + 1;
  while (i < data.end - 1) {
    while (/[\s,]/.test(js[i] ?? '')) i += 1;
    if (js[i] === '}') break;
    const keyEnd = scanJsonValue(js, i);
    const name = JSON.parse(js.slice(i, keyEnd)) as string;
    i = keyEnd;
    while (/[\s:]/.test(js[i] ?? '')) i += 1;
    const valueEnd = scanJsonValue(js, i);
    if (name === key) return { start: i, end: valueEnd };
    i = valueEnd;
  }
  throw new Error(`key ${key} not found in data object`);
}

/**
 * Serve a patched `resource` inside the original container script (same runtime, permissions and
 * sandboxed templates). Used by the watchdog's --patch-container.
 */
export function spliceResourceIntoContainerJs(js: string, resource: unknown): string {
  const span = findTopLevelValue(js, 'resource');
  return js.slice(0, span.start) + JSON.stringify(resource) + js.slice(span.end);
}
