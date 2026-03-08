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

```bash
git fetch upstream
git merge upstream/main --no-edit
npm install                       # if package.json changed
npm run dev:hyper                 # verify everything works
git push origin main
```

Recommended cadence: **weekly**, or when upstream has significant updates.

## File Modification Rules

### 🟢 Safe Zone — New files, zero merge conflicts

| Path                         | Purpose                    |
| ---------------------------- | -------------------------- |
| `src/components/hyper/`      | Custom components & panels |
| `src/styles/hyper-theme.css` | Custom theme               |
| `src/locales/hyper/`         | Hyper-specific i18n keys   |
| `api/hyper/`                 | Custom API endpoints       |
| `data/hyper/`                | Custom data files          |

### 🟡 Register Zone — Minimal edits to upstream files (~2-5 lines each)

These files need small additions to register the hyper variant:

| File                         | What to add                         |
| ---------------------------- | ----------------------------------- |
| `src/config/variant-meta.ts` | `hyper` metadata entry              |
| `src/config/variant.ts`      | `hyper` hostname detection          |
| `src/config/panels.ts`       | `HYPER_*` config + ternary branches |
| `package.json`               | `dev:hyper` / `build:hyper` scripts |

### 🔴 Forbidden Zone — Do NOT modify

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
upstream: merge upstream/main (91 commits)
fix(deps): apply npm audit fix
```

## Deployment

- **Platform**: Vercel (auto-deploy on push to `main`)
- **Dev**: `npm run dev:hyper`
- **Build**: `npm run build:hyper`
- **Env vars**: `.env.local` (gitignored)
