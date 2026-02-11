#!/usr/bin/env sh
set -eu

# nanobot expects config at ~/.nanobot/config.json (Path.home() / ".nanobot" / "config.json")
# STATE_DIR is the persistent volume mount (e.g. /home/nanobot/.nanobot)
STATE_DIR="${NANOBOT_STATE_DIR:-/home/nanobot/.nanobot}"
mkdir -p "$STATE_DIR"

# Privilege-drop wrapper: Akash volumes mount root-owned.
# If root, chown for nanobot user then re-exec this script.
if [ "$(id -u)" = "0" ]; then
  chown -R nanobot:nanobot "$STATE_DIR" 2>/dev/null || true
  if command -v gosu >/dev/null 2>&1; then
    exec gosu nanobot "$0" "$@"
  fi
  if command -v su-exec >/dev/null 2>&1; then
    exec su-exec nanobot "$0" "$@"
  fi
  exec su -s /bin/sh nanobot -c "exec \"$0\" $*"
fi

# Run as nanobot user from here.
# HOME must be parent of .nanobot so ~/.nanobot resolves correctly
export HOME="${STATE_DIR}/.."
mkdir -p "$HOME/.nanobot"
CONFIG_FILE="$HOME/.nanobot/config.json"

# Generate config.json from env vars (nanobot reads ~/.nanobot/config.json)
python3 << PYEOF
import json
import os

providers = {}
provider_env = [
    ('openrouter', 'OPENROUTER_API_KEY'),
    ('anthropic', 'ANTHROPIC_API_KEY'),
    ('openai', 'OPENAI_API_KEY'),
    ('deepseek', 'DEEPSEEK_API_KEY'),
    ('groq', 'GROQ_API_KEY'),
]
for name, env_key in provider_env:
    key = os.environ.get(env_key)
    if key and key.strip():
        providers[name] = {'apiKey': key.strip()}

model = os.environ.get('NANOBOT_DEFAULT_MODEL', 'anthropic/claude-opus-4-5')
if not providers and os.environ.get('OPENROUTER_API_KEY'):
    providers['openrouter'] = {'apiKey': os.environ['OPENROUTER_API_KEY']}

config = {
    'providers': providers,
    'agents': {'defaults': {'model': model}},
}
with open('$CONFIG_FILE', 'w') as f:
    json.dump(config, f, indent=2)
PYEOF

# Fallback: minimal config if Python failed
if [ ! -f "$CONFIG_FILE" ] || [ ! -s "$CONFIG_FILE" ]; then
  mkdir -p "$(dirname "$CONFIG_FILE")"
  echo '{"providers":{},"agents":{"defaults":{"model":"anthropic/claude-opus-4-5"}}}' > "$CONFIG_FILE"
fi

# Fail fast if no API keys — nanobot exits immediately otherwise
if ! python3 -c "
import json
with open('$CONFIG_FILE') as f:
    cfg = json.load(f)
providers = cfg.get('providers', {})
if not any(p.get('apiKey') for p in providers.values()):
    print('ERROR: No LLM API key configured. Set OPENROUTER_API_KEY (or ANTHROPIC_API_KEY, etc.) in deployment env.')
    exit(1)
" 2>/dev/null; then
  echo "nanobot requires at least one LLM API key. Add OPENROUTER_API_KEY or ANTHROPIC_API_KEY in the deployment."
  exit 1
fi

exec nanobot gateway
