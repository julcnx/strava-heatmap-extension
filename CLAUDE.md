# Release process

## When creating a new version branch `vX.Y.Z`

Make this the first commit on the branch, before any other work, so the loaded
extension already shows the version being tested:

1. Bump `"version"` in `manifest.json` to `X.Y.Z` (`package.json` stays `0.0.0`).
2. Add an entry at the top of `CHANGELOG.md`, under `## Versions`:
   `` ### `X.Y.Z` (YYYY-MM-DD) `` followed by the changes.

Work directly on `vX.Y.Z`: don't create extra branches for it.

## When releasing

1. Update the `CHANGELOG.md` date to the release day.
2. Build the store zips with `npm run build` (`dist/X.Y.Z-chrome.zip`, `dist/X.Y.Z-firefox.zip`).
3. Fast-forward `master` to `vX.Y.Z`, then push `master` and `vX.Y.Z`.
4. Never delete version branches: the logged-out fallback image URL points at
   `refs/heads/vX.Y.Z` (see `getTileTemplate` in `src/clients/common/layers.js`).
