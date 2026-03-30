# HyperMonitor Development Guide

## Overview

HyperMonitor is a customized fork of [koala73/worldmonitor](https://github.com/koala73/worldmonitor). We maintain a `hyper` variant that allows deep customization while continuously merging upstream updates.

## Quick Start

```bash
npm install
npm run dev:hyper    # Start hyper variant on localhost:3000
```

## Git Remotes

```
origin   → github.com/ybwbqg9379/hypermonitor   (our fork)
upstream → github.com/koala73/worldmonitor       (original)
```

## Upstream Sync

> CI uses **Node 22 / npm 10**. If your local Node version differs (e.g. Node 25 / npm 11),
> the auto-merged `package-lock.json` will almost certainly break CI.
> **Always regenerate the lock file from scratch after merging upstream.**

### Full Procedure

```bash
# 1. Fetch and merge
git fetch upstream
git merge upstream/main --no-edit

# 2. Resolve any conflicts (typically vercel.json CSP changes)
#    - Accept upstream's CSP hashes / source patterns
#    - Re-add our hyperinsights.vercel.app to frame-ancestors
#    - Re-add any hyper-specific origins

# 3. CRITICAL: Regenerate package-lock.json from scratch
#    The auto-merged lock file is unreliable across npm versions.
rm -rf node_modules blog-site/node_modules package-lock.json
npm install

# 4. Local verification (must all pass before push)
npm run typecheck                # TypeScript — zero errors
npm run test:data                # Unit tests — zero failures
npx -y npm@10 ci --dry-run      # Simulate CI's npm version

# 5. Commit and push
git add -A
git commit -m "chore: merge upstream/main (N commits) -- brief description"
git push origin main
```

### Why Lock File Regeneration Is Required

When `git merge` auto-merges `package-lock.json`, the result is often subtly
corrupted — peer dependency references from one side may reference packages that
are only resolved in the other side's tree. npm 11 silently tolerates these
orphaned references, but CI's npm 10 runs `npm ci` which strictly validates
every reference and fails on any mismatch.

**Lesson from 2026-03-17**: After merging 57 upstream commits, CI failed on all
3 workflows (Typecheck, Lint, Test) with `Missing: commander@13.1.0 from lock file`.
The `c12` package declared `commander@^13.1.0` as an optional peer dep, but the
auto-merged lock file had a dangling reference without a resolved version. Only
a full `rm + npm install` from scratch produced a clean tree.

Recommended cadence: **weekly**, or when upstream has significant updates.

### Common Conflict Zones

| File                   | Typical Conflict                   | Resolution                                                  |
| ---------------------- | ---------------------------------- | ----------------------------------------------------------- |
| `vercel.json`          | CSP script hashes, source patterns | Accept upstream hashes + keep our `frame-ancestors` entries |
| `package.json`         | New dependencies                   | Accept upstream + keep our `dev:hyper` scripts              |
| `src/config/panels.ts` | New panel definitions              | Accept upstream + keep our `HYPER_*` configs                |
| `vite.config.ts`       | Build config changes               | Accept upstream + keep our embed/CSP customizations         |

### Post-Merge Test Checklist

After merging upstream, check if any tests need updating for our customizations:

- **`tests/country-geometry-overrides.test.mts`**: We self-host GeoJSON at
  `/data/country-boundary-overrides.geojson` instead of upstream's CDN URL.
  If upstream changes the override URL, update the test mock to match our path.
- **`tests/deploy-config.test.mjs`**: Reads `vercel.json` directly. If we change
  CSP headers or source patterns, the security header guardrails may need updating.

## File Modification Rules

### Safe Zone -- New files, zero merge conflicts

| Path                         | Purpose                    |
| ---------------------------- | -------------------------- |
| `src/components/hyper/`      | Custom components & panels |
| `src/styles/hyper-theme.css` | Custom theme               |
| `src/locales/hyper/`         | Hyper-specific i18n keys   |
| `api/hyper/`                 | Custom API endpoints       |
| `data/hyper/`                | Custom data files          |

### Register Zone -- Minimal edits to upstream files (~2-5 lines each)

These files need small additions to register the hyper variant:

| File                         | What to add                         |
| ---------------------------- | ----------------------------------- |
| `src/config/variant-meta.ts` | `hyper` metadata entry              |
| `src/config/variant.ts`      | `hyper` hostname detection          |
| `src/config/panels.ts`       | `HYPER_*` config + ternary branches |
| `package.json`               | `dev:hyper` / `build:hyper` scripts |

### Forbidden Zone -- Do NOT modify

| Path                                 | Reason                 |
| ------------------------------------ | ---------------------- |
| `src/components/panels/*.ts`         | Upstream panel logic   |
| `src/services/*.ts`                  | Upstream service layer |
| `server/*.ts`                        | Upstream API handlers  |
| `src/locales/en.json` / `zh.json`    | Upstream i18n files    |
| `src/styles/main.css` / `panels.css` | Upstream core styles   |

> **Exception**: If you must change upstream logic for hyper, use `if (SITE_VARIANT === 'hyper')` guards or the Wrapper Pattern (create new file that imports and wraps the original).

## i18n Strategy

- Upstream already has 21 languages with >90% Chinese coverage
- Hyper-specific translations go in `src/locales/hyper/{en,zh}.json`
- Use i18next namespaces to avoid key collisions with upstream

## Commit Conventions

```
feat(hyper): add custom dashboard panel
fix(hyper): correct map layer defaults
style(hyper): update theme colors
chore: merge upstream/main (57 commits) -- widgets, forecast, sanctions
fix(deps): apply npm audit fix
fix(ci): regenerate package-lock.json for npm 10/11 compat
fix(test): update test mocks to match self-hosted paths
```

## Deployment

- **Platform**: Vercel (auto-deploy on push to `main`)
- **Dev**: `npm run dev:hyper`
- **Build**: `npm run build:hyper`
- **Env vars**: `.env.local` (gitignored)

## Troubleshooting

### `npm ci` fails with "Missing: X from lock file"

**Cause**: `package-lock.json` was auto-merged by git and contains orphaned peer
dependency references that npm 10 (CI) rejects.

**Fix**:

```bash
rm -rf node_modules blog-site/node_modules package-lock.json
npm install
git add package-lock.json
git commit -m "fix(ci): regenerate package-lock.json from scratch"
```

### Tests fail after upstream merge

Check the Post-Merge Test Checklist above. Common causes:

- URL mocks in tests don't match our self-hosted paths
- `vercel.json` security header assertions don't match our CSP customizations
- New upstream panels reference config keys not present in `HYPER_PANELS`
