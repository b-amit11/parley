#!/bin/sh
# Entry point for deploy/single.Dockerfile. With SEED_DEMO=true, creates the demo users
# (alice / bob / carol) and a sample workspace first; the seed is idempotent across restarts.
set -e
if [ "$SEED_DEMO" = "true" ]; then
  node --import tsx apps/server/src/seed.ts
fi
exec node --import tsx apps/server/src/main.ts
