# HubberHub

A macOS menu bar app for triaging GitHub notifications with AI-powered classification.

![HubberHub screenshot](https://andrialexandrou.github.io/chat-made/assets/hubberhub.png)

## What it does

HubberHub uses a hybrid classification system to sort your GitHub notifications into actionable sections:

- **Action Needed** — PRs you're requested to review, threads you're mentioned in, issues assigned to you
- **State Changes** — PRs merged/closed that you were following
- **Everything Else** — Low-priority notifications you can batch-clear

Deterministic rules handle the clear-cut cases. For ambiguous notifications (e.g. you're the PR author and get a comment), GPT-4o-mini via the [GitHub Models API](https://docs.github.com/en/github-models) makes the judgment call.

## Features

- **Menu bar tray icon** with green indicator when action items exist
- **Desktop notifications** for new action items
- **Power-aware polling** — refreshes on wake from sleep
- **One-click actions** — mark as done, unsubscribe, open in browser
- **Right-click context menu** on notification rows
- **Light/dark theme** following system preferences
- **Inbox zero** state with a friendly octocat illustration

## Prerequisites

- macOS
- [GitHub CLI](https://cli.github.com/) installed and authenticated (`gh auth login`)
- Access to [GitHub Models API](https://docs.github.com/en/github-models) for AI triage (optional — deterministic rules work without it)

## Install

```bash
# Clone and install dependencies
git clone https://github.com/andrialexandrou/hubberhub.git
cd hubberhub
npm install

# Run in dev mode
npm run dev

# Build and install to /Applications
npm run build && npm run package
```

## How it works

- **Electron main process** handles all GitHub API calls, LLM classification, tray icon, and power monitoring
- **React renderer** displays the notification UI with section-based layout
- **Vite** builds the React app; Electron loads the built output
- Polls every 5 minutes from the main process (more reliable than renderer-based polling)
- Caches notification context and triage results in `~/Library/Application Support/hubberhub/cache/`

## Built with

Claude via [GitHub Copilot CLI](https://githubnext.com/projects/copilot-cli/), using a custom agent skill for scaffolding and packaging native macOS desktop apps with Electron + React.
