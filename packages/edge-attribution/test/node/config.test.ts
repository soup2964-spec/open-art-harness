// Guards the example config: placeholders only, the bindings the code expects, no secret values.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8");

describe("wrangler.toml", () => {
  // Config lines only: comments may mention real hosts to explain what OpenArt keeps.
  const toml = read("wrangler.toml")
    .split("\n")
    .map((l) => l.replace(/\s*#.*$/, ""))
    .join("\n");

  it("binds ATTRIBUTION_KV and declares ATTRIBUTION_SECRET as a required secret", () => {
    expect(toml).toMatch(/\[\[kv_namespaces\]\]\s*\nbinding = "ATTRIBUTION_KV"/);
    expect(toml).toMatch(/\[secrets\]\s*\nrequired = \["ATTRIBUTION_SECRET"\]/);
    expect(toml).toMatch(/^main = "src\/example-worker\.ts"$/m);
  });

  it("contains only placeholder ids and hosts (nothing deployable to a real zone)", () => {
    for (const id of toml.matchAll(/^\s*(?:id|preview_id)\s*=\s*"([^"]*)"/gm)) expect(id[1]).toMatch(/^(0{32}|1{32})$/);
    for (const host of toml.matchAll(/(?:pattern|zone_name)\s*=\s*"([^"]*)"/g)) expect(host[1]).toMatch(/^example\.com(\/\*)?$/);
    expect(toml).not.toMatch(/openart\.ai\/\*/);
    expect(toml).not.toMatch(/account_id/);
    expect(toml).toMatch(/workers_dev = false/);
  });

  it("never contains a secret value", () => {
    expect(toml).not.toMatch(/^\s*ATTRIBUTION_SECRET\s*=/m);
  });
});

describe(".gitignore", () => {
  it("keeps .dev.vars out of git and the edge-sim build in", () => {
    const gi = read(".gitignore");
    expect(gi).toMatch(/^\.dev\.vars$/m);
    expect(gi).toMatch(/^!\/dist\/$/m);
  });
});
