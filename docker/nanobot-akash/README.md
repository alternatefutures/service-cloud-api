# nanobot-akash

Wrapper image for deploying [nanobot](https://github.com/HKUDS/nanobot) on Akash Network.

## What it does

- Generates `~/.nanobot/config.json` from environment variables at boot
- Drops privileges for persistent volume (Akash mounts as root)
- Runs `nanobot gateway` on port 18790

## Build & push

From the `AlternateFutures` repo root:

```bash
cd service-cloud-api
docker build --platform linux/amd64 -f docker/nanobot-akash/Dockerfile -t ghcr.io/alternatefutures/nanobot-akash:v1 .
docker push ghcr.io/alternatefutures/nanobot-akash:v1
```

**Important:** Use `--platform linux/amd64` for Akash providers. Use versioned tags (e.g. `:v1`), not `:latest`.

## Required env vars

At least one LLM provider API key:

- `OPENROUTER_API_KEY` (recommended — access to all models)
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `DEEPSEEK_API_KEY`
- `GROQ_API_KEY`

Optional: `NANOBOT_DEFAULT_MODEL` (default: `anthropic/claude-opus-4-5`)

## No web UI

nanobot is CLI + chat channel only. Access via:

- Telegram, Discord, Slack, WhatsApp, etc. (configure in `config.json` after deploy)
- Or run `nanobot agent -m "..."` inside the container (not typical for Akash)
