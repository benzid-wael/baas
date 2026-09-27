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

gate "1/10 format"          pnpm run format:check
gate "2/10 lint"            pnpm run lint
gate "3/10 typecheck"       pnpm run typecheck
gate "4/10 no \`any\`"       node scripts/check-any.mjs
gate "5/10 boundaries"      node scripts/check-boundaries.mjs
gate "6/10 money"           node scripts/check-money.mjs
gate "7/10 config parity"  node scripts/check-config-parity.mjs
gate "8/10 tenant scope"   node scripts/check-tenant-scope.mjs
gate "9/10 openapi"        pnpm run check:openapi
gate "10/10 secrets"       node scripts/check-secrets.mjs

printf '\n\033[1m── tests (schema drift, migration rollback and coverage included)\033[0m\n'
pnpm run test:coverage

printf '\n\033[1;32mAll gates passed.\033[0m\n'
