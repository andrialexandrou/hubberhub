# HubberHub — Project Context

## What This Is
A macOS menu bar Electron + React desktop app for triaging GitHub notifications with smart classification. Built for user `andrialexandrou`. Installed to `/Applications/HubberHub.app`.

## Architecture
- **Electron main process** (`main.js`): All GitHub API calls, LLM calls, tray icon, power monitor, IPC handlers
- **React renderer** (`src/App.jsx`): Notification UI with sections (Action Needed / For Your Info / State Changes)
- **Preload bridge** (`preload.js`): IPC via `contextBridge` — `contextIsolation: true`, `nodeIntegration: false`
- **Vite** builds React to `dist/`, Electron loads `dist/index.html`

## Hybrid Triage System
Deterministic rules handle clear-cut cases in `classifyByRules()`:
- Team mentions → noise
- Personal review requests → action
- Direct @mentions, assigns → action
- User participated (left reviews/comments) on a thread → action
- Team-only review requests (user not in requestedReviewers, hasn't participated) → noise
- `reason=comment` (reply on thread user commented on) → action
- `reason=author` → ambiguous, sent to LLM (GPT-4o-mini via GitHub Models API)
- `reason=subscribed` without participation → noise

Only `reason=author` and unrecognized reasons go to the LLM.

## Key Features
- **Tray icon**: Black octocat (template) when clear, green when action items exist
- **Desktop notifications**: For new action items; dismissed when app window is focused
- **Power monitor**: `powerMonitor.resume` triggers refresh on wake from sleep
- **Main-process polling**: 5-minute `setInterval` in main (not renderer — more reliable during sleep)
- **Caching**: Context cache + triage cache in `~/Library/Application Support/hubberhub/cache/`
- **Right-click menu**: On notification rows — Open in Browser, Copy URL, Unsubscribe
- **Mark as done**: Uses `DELETE /notifications/threads/:id` (not PATCH, which only marks as read)
- **Author display**: Latest actor (green, before title), original author (dim gray "by X" after title)
- **Bot filtering**: `lastCommentBy` skips bot accounts (ending in `[bot]` or `type: Bot`)
- **Participation detection**: Checks PR reviews + comments to see if user engaged, upgrades to action
- **Optimistic UI**: Unsubscribe/dismiss removes item immediately without full refresh
- **Inbox zero**: Shows octocat illustration only after loading completes (not during)
- **System theme**: CSS custom properties for light/dark mode

## GitHub API Quirks
- `PATCH /threads/:id` = mark as **read** (stays in inbox)
- `DELETE /threads/:id` = mark as **done** (archived)
- `PUT /notifications` = bulk mark as read only
- Omit `?all=true` to get unread only
- `DELETE /threads/:id/subscription` = unsubscribe
- Notification `reason` doesn't update when user engages — must check participation separately
- Requested teams may be dismissed by the time we fetch PR details — check `requestedReviewers` directly

## Dev Workflow
```bash
cd /Users/aja/ajaWorkspace/gh-notifications-ui

# Dev mode (unreliable for testing — dies when shell killed)
npm run dev

# Build + install to /Applications (preferred for testing)
npx vite build && npm run package && cp -R out/HubberHub-darwin-arm64/HubberHub.app /Applications/ && open /Applications/HubberHub.app

# Clear caches after changing rules/prompt
rm -f ~/Library/Application\ Support/hubberhub/cache/*.json

# Quit before reinstalling
osascript -e 'quit app "HubberHub"'
```

## Important Files
| File | Purpose |
|------|---------|
| `main.js` | Core: Electron main, API, rules engine, LLM, caching, tray, IPC |
| `src/App.jsx` | React UI: notification rows, sections, empty state |
| `src/App.css` | Styling: light/dark theme, compact rows, state pills |
| `preload.js` | IPC bridge between main and renderer |
| `assets/` | Tray icons (template + green), app icon, inbox-zero SVG |

## Pending / Known Issues
- Xcode license may block git commits — run `sudo xcodebuild -license accept`
- Several changes uncommitted (author display, participation check, bot filtering, tray sync, optimistic unsubscribe, notification clearing on focus, initial load fix)
- `reason=comment` always → action may be too aggressive — revisit based on usage
