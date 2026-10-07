# Flow Launcher

One-click launcher for aria-flow: local backend, local desktop (→ prod or local backend), or the installed Wispr Flow.

- `npm start` — run from source
- `npm run package` — build `~/Applications/Flow Launcher.app`

Settings (selected worktree, feature flag overrides) persist in `~/Library/Application Support/Flow Launcher/settings.json`.
Flag overrides are passed as `WISPR_FEATURE_FLAGS` and only reach local (development) desktop builds.
