# baas

Superchat banking platform, second generation. Design lives in
`superchat-platform/RFCs/BaaS/` — `rfc-baas-architecture.md` for the design,
`breakdown.md` for the plan of record, `rollout.md` for what ships when.

## Requirements

- Node 24 (see `.nvmrc`)
- pnpm 9

## Commands

| Command                    | What it does                                         |
| -------------------------- | ---------------------------------------------------- |
| `pnpm verify`              | Every local gate, in the order CI runs them          |
| `pnpm format` / `:check`   | Prettier                                             |
| `pnpm lint`                | ESLint, type-checked on source, syntactic on tooling |
| `pnpm typecheck`           | `tsc --build` across the project references          |
| `pnpm check:domain-purity` | Asserts `packages/domain` depends on nothing         |
| `pnpm test` / `:coverage`  | Vitest; coverage thresholds at 70%                   |

## Layout

```
packages/
  domain/        framework-free core. Zero runtime dependencies, enforced.
```

Everything else in the RFC's layout arrives with its task. The workspace is
built one package at a time, and each arrives with its gate already passing.

## The domain purity rule

`packages/domain` declares no `dependencies` and no `peerDependencies`, and
imports nothing but relative paths. Two mechanisms hold it:

1. `pnpm check:domain-purity` inspects the manifest and every import. This is
   the **primary** enforcement.
2. pnpm's isolated `node_modules` makes an undeclared package unresolvable —
   but only if that package is absent from the workspace root as well. Node
   resolution walks up the directory tree, so a root `devDependency` is
   visible from every package regardless of what pnpm does. The root therefore
   declares **only the toolchain**, never a runtime library.
