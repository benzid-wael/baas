#!/usr/bin/env bash
#
# The gates, in the order they run in CI (RFC-BaaS §10.1).
#
# This lives in the repository, invoked by a thin Jenkinsfile, because the
# incumbent's Jenkinsfile is two lines into a shared library and its CI is
# unreadable from the repository (finding E2). Anyone can run this locally and
# get exactly what CI gets.
set -euo pipefail

cd "$(dirname "$0")/../.."

gate() {
  printf '\n\033[1m── %s\033[0m\n' "$1"
  shift
  "$@"
}

gate "1/12 format"          pnpm run format:check
gate "2/12 lint"            pnpm run lint
gate "3/12 typecheck"       pnpm run typecheck
gate "4/12 no \`any\`"       node scripts/check-any.mjs
gate "5/12 boundaries"      node scripts/check-boundaries.mjs
gate "6/12 money"           node scripts/check-money.mjs
gate "7/12 config parity"  node scripts/check-config-parity.mjs
gate "8/12 tenant scope"   node scripts/check-tenant-scope.mjs
gate "9/12 openapi"        pnpm run check:openapi
gate "10/12 secrets"       node scripts/check-secrets.mjs
# The portal is a bundle, and a bundle that type-checks can still fail to
# build — an unresolvable import, a plugin that cannot see a file. It costs
# under a second, and "it compiles" is not the same claim as "it ships".
gate "11/12 portal bundle" pnpm --filter @baas/portal run build
# New-18: compose and the Dockerfile both referenced a `main.js` that was never
# built, for several milestones, because nothing in CI reads these files.
gate "12/12 docker refs"   node scripts/check-docker-refs.mjs

printf '\n\033[1m── tests (schema drift, migration rollback and coverage included)\033[0m\n'
pnpm run test:coverage

printf '\n\033[1;32mAll gates passed.\033[0m\n'
