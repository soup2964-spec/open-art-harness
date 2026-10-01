#!/usr/bin/env bash
# Offline proof that every model and data test compiles for BigQuery.
#
# 1. `dbt compile` with the real dbt-bigquery adapter against a throwaway compile-only profile:
#    a dummy OAuth token (not a credential), and HTTP(S)/gRPC proxies pointed at a closed local
#    port, so any attempt to reach Google fails instead of sending anything.
# 2. Every compiled .sql is parsed with sqlglot's BigQuery dialect.
# Unit tests are excluded: dbt introspects their input relations, which needs a live warehouse.
# is_incremental() also needs one, so the incremental models are pinned to their incremental
# branch (compile_check_force_incremental), and the readout's bootstrap SQL is switched on.
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE_DIR="target/bigquery_compile_profile"
OUT_DIR="target/bigquery_compile"
mkdir -p "$PROFILE_DIR"
cat > "$PROFILE_DIR/profiles.yml" <<'YAML'
openart_signal:
  target: compile_check
  outputs:
    compile_check:
      type: bigquery
      method: oauth-secrets
      token: not-a-credential-compile-only
      project: openart-compile-check
      dataset: openart_signal
      location: US
      threads: 4
YAML

export DO_NOT_TRACK=1 DBT_SEND_ANONYMOUS_USAGE_STATS=False

# The real `prod` target in profiles.yml must render and parse (env vars only, no credentials).
uv run --quiet --with "dbt-core==1.12.5" --with "dbt-bigquery==1.12.1" \
  env OPENART_BQ_PROJECT=openart-compile-check HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 \
      https_proxy=http://127.0.0.1:9 http_proxy=http://127.0.0.1:9 grpc_proxy=http://127.0.0.1:9 \
      NO_PROXY= no_proxy= NO_GCE_CHECK=True GCE_METADATA_HOST=127.0.0.1:9 \
  dbt parse --profiles-dir . --target prod --target-path "$OUT_DIR-prod-parse"

# uv resolves the toolchain first (normal network); the proxies apply to the dbt process only.
uv run --quiet --with "dbt-core==1.12.5" --with "dbt-bigquery==1.12.1" \
  env HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 \
      https_proxy=http://127.0.0.1:9 http_proxy=http://127.0.0.1:9 grpc_proxy=http://127.0.0.1:9 \
      NO_PROXY= no_proxy= NO_GCE_CHECK=True GCE_METADATA_HOST=127.0.0.1:9 \
  dbt compile --profiles-dir "$PROFILE_DIR" --target compile_check --target-path "$OUT_DIR" \
    --no-populate-cache --exclude "resource_type:unit_test" \
    --vars '{compile_check_force_incremental: true, readout_bootstrap_replicates: 10}'

uv run --quiet --with sqlglot python - "$OUT_DIR" <<'PY'
import sys
from pathlib import Path

import sqlglot

root = Path(sys.argv[1]) / "compiled"
files = sorted(root.rglob("*.sql"))
if len(files) < 40:
    raise SystemExit(f"expected the whole project to compile, found {len(files)} files")
errors = []
for f in files:
    try:
        sqlglot.parse(f.read_text(), read="bigquery")
    except Exception as exc:  # noqa: BLE001 - report every file
        errors.append(f"{f.relative_to(root)}: {exc}")
leaks = [f for f in files if any(tok in f.read_text() for tok in ("json_extract_string", "regexp_matches", "make_timestamp", "epoch_us", "::json"))]
if errors or leaks:
    print("\n".join(errors + [f"DuckDB-only syntax in {f.relative_to(root)}" for f in leaks]))
    raise SystemExit(1)
print(f"BigQuery: {len(files)} compiled files parse with the BigQuery dialect; no DuckDB-only functions")
PY
