# Prompt Factory

Prompt Factory is a personal local desktop GUI for coding agents. It runs local models through [LM Studio](https://lmstudio.ai/) by default, with optional online modes via the Claude and Codex SDKs.

## Providers

- **LM Studio (local, default)** — any model you have loaded in LM Studio at `http://127.0.0.1:1234`.
- **Claude (online)** — via `@anthropic-ai/claude-agent-sdk`. Run `claude auth login` once.
- **Codex (online)** — via `codex app-server`. Install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`.

## Run locally

```bash
bun install
bun run dev
```

## Build the desktop app

```bash
# macOS
bun run dist:desktop:dmg

# Windows
bun run dist:desktop:win

# Linux
bun run dist:desktop:linux
```

Installable artifacts land in `dist/`.

## Personal repository

This is a personal fork rebranded for local use. Origin: [Mukela12/prompt-factory-app](https://github.com/Mukela12/prompt-factory-app).
