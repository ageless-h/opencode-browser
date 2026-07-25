# Goal

Make browser automation predictable without relying on unsafe JavaScript eval, so visible on‑screen content (like verification tokens) is accessible via generic, reusable primitives.

## What I changed

- Added resilient DOM access primitives to the extension: deep query across shadow DOM + same‑origin iframes, indexed click/type, and a unified `browser_query` that supports waiting and `page_text` extraction.
- Expanded `browser_snapshot` to include visible text and richer node metadata so on‑screen strings are observable without eval.
- Removed `browser_execute` from the public tool surface to avoid CSP/unsafe‑eval failures.
- Updated the plugin surface and README tool list to expose the minimal primitives.

## Why

- Native messaging and the broker make transport predictable, but they do not bypass CSP.
- Relying on `eval` breaks on strict pages (e.g., Google Admin Console), so we need stable, declarative primitives that mimic user‑visible access.

## Remaining tasks (if any)

- Validate the new primitives on the real Admin Console flow to confirm the verification token is visible via `browser_query` with `mode=page_text`.
- Consider adding higher‑level “copy button” helpers only if real‑world flows still fail.

## Notes

- All changes are generic (no Google‑specific logic).
- Only declarative primitives are exposed; no arbitrary JS execution.
