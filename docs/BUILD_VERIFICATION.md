# Watson — H&R AI IT Agent : Build Verification Record

**Latest pass:** 2026-06-26 — **Next.js 16 security/platform migration** (no feature changes).
**Supersedes** the earlier Next 14.2.35 record below.

## Outcome (Next 16 migration)
✅ **Security gate CLEARED.** Migrated 14.2.35 → **Next 16.2.9** (with React 19). The production build
succeeds, all static checks pass, and `npm audit` reports **0 vulnerabilities** (was 4 high + 1 moderate).

## Active working path
- **Active build copy:** `C:\Dev\Watson` (this migration was performed here).
- **Preserved original:** `C:\Users\chatt\OneDrive\Documents\Claude\Projects\Watson` (NOT modified in this pass).

## Environment
| Item | Value |
|------|-------|
| OS | Microsoft Windows 11 (10.0.26200) |
| Node (this session) | v26.1.0 |
| Node LTS pin (CI/deploy) | **24** via `.nvmrc` (CI uses `node-version-file`) |
| npm | 11.13.0 |
| Inside OneDrive during build? | No (`C:\Dev\Watson`) |
| Clean install (rm node_modules + lockfile)? | Yes |

## Dependencies (exact, after migration)
| Package | Version |
|---------|---------|
| next | 16.2.9 |
| react / react-dom | 19.2.7 |
| eslint | 9.39.4 |
| eslint-config-next | 16.2.9 |
| @types/react | 19.2.17 |
| @types/react-dom | 19.2.3 |
| @types/node | 24.13.2 |
| typescript | 5.5.3 |
| tailwindcss | 3.4.6 |
| postcss | 8.5.15 (+ `overrides.postcss = 8.5.15` to patch Next''s bundled copy) |
| autoprefixer | 10.4.19 |
| tsx | 4.22.4 |

## Verified commands (Windows, `C:\Dev\Watson`)
| Command | Result | Notes |
|---------|--------|-------|
| `npm install` | ✅ exit 0 | 388 packages, `found 0 vulnerabilities` |
| `npm run it-agent:selftest` | ✅ 63 passed, 0 failed | all guardrails intact |
| `npx tsc --noEmit` | ✅ exit 0 | no type errors under React 19 / Next 16 types |
| `npm run build` | ✅ exit 0 | 21 routes compiled (Next 16 / Turbopack-era build) |
| `npm run lint` (`eslint .`) | ✅ exit 0 | 0 errors, 7 non-blocking warnings (see below) |
| `npm audit` | ✅ **0 vulnerabilities** | 0 critical / 0 high / 0 moderate |

### Lint note (7 warnings, non-blocking)
eslint-config-next 16 adds `react-hooks/set-state-in-effect` (react-hooks v7). It warns on 7 client
components that initialize **client-only** state (e.g. reading `document.cookie` for the demo role)
inside an effect after mount. Moving these to a `useState` initializer would execute during SSR
(`document` undefined) and cause **hydration mismatches**, so the effect pattern is the correct,
hydration-safe choice. The rule is set to `warn` (visible, non-blocking) and documented in
`eslint.config.mjs`. `next lint` was removed in Next 16; lint now runs via `eslint .` (flat config).

## Next.js 16 migration changes
- Dynamic route `params` are now async (`Promise`). Updated 3 route handlers + 2 page components to
  type `params: Promise<{...}>` and `await` them.
- `next lint` removed → ESLint flat config (`eslint.config.mjs`) importing
  `eslint-config-next/core-web-vitals` directly; script changed to `eslint .`.
- React upgraded 18.3.1 → 19.2.7 (Next 16''s supported pairing). No component type changes required.
- `tsconfig.json` `jsx` auto-set to `react-jsx` by the Next 16 build (React automatic runtime).
- No `cookies()/headers()/searchParams` server-API migrations were needed (none used server-side).

## Continuous integration

`.github/workflows/ci.yml` runs on every push/PR on the pinned Node LTS (`node-version-file: .nvmrc` = 24):
`npm ci` -> `npm run it-agent:selftest` -> `npx tsc --noEmit` -> `npm run build` -> `npm run lint` ->
`npm audit --audit-level=high`. The audit step fails the build only on **high/critical** advisories
(the security gate). Validated locally: `npm ci` exit 0 (387 packages, 0 vulnerabilities), and the full
suite passes.

### engines.node decision
`engines.node` = **`>=22.11.0`** — the supported-LTS floor. Node 20 is **EOL** (excluded); Node 22 is an
active LTS (allowed); Node 24 is the canonical pinned target via `.nvmrc` + CI. Tighten to `>=24` only if
hard single-version lock-in is desired (it would exclude the still-supported Node 22 LTS).

### dependency note
`@eslint/eslintrc` is no longer a direct devDependency (the flat config imports
`eslint-config-next/core-web-vitals` directly); it remains only as a transitive dep of `eslint`.

## Deployability conclusion (honest)
- **Dependency / security gate:** ✅ **CLEARED** — 0 high/critical/moderate advisories; clean build.
- **Product readiness:** ⚠️ Still a **MOCK-ONLY MVP** — demo role-switcher auth (no real identity),
  JSON file store (no database), deterministic AI (no LLM), and all M365 / device-RMM connectors are
  mock. **Do not deploy as a real IT system** until real auth (Entra ID), a database, and reviewed
  integrations are added. This pass did **not** deploy, applied **no** migration, made **no** external
  calls, and kept live external execution disabled.

---

## (Historical) Next 14.2.35 record
Previously: build passed locally on Windows; `npm audit` = 5 advisories (4 high, 1 moderate), the
high `next` one only fixable by Next 16 → project was marked NOT deployable. That gate is now cleared
by this Next 16 migration.
