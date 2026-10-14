# Flow Launcher

One-click launcher for aria-flow: local backend, local desktop (→ prod or local backend), or the installed Wispr Flow.

- `npm start` — run from source
- `npm run package` — build `~/Applications/Flow Launcher.app`

Choose backend and frontend (desktop) worktrees independently; each selector shows its checked-out branch. The Local desktop tile starts the selected backend and connects the desktop to that backend’s ports and local auth. Prod and Staging desktop tiles use only the frontend selection. Changing a selection takes effect on the next launch.

Settings (selected backend and frontend worktrees, feature flag overrides) persist in `~/Library/Application Support/Flow Launcher/settings.json`.
Flag overrides are passed as `WISPR_FEATURE_FLAGS` and only reach local (development) desktop builds.

<img width="1093" height="814" alt="image" src="https://github.com/user-attachments/assets/fa5c6de7-60e1-4883-9945-cc200eaf28f1" />
