#!/bin/bash
# ==============================================
# Skill Pilot Agent — Quick Start
# ==============================================
# Usage:
#   ./run-agent.sh                        # REPL mode (multi-turn)
#   ./run-agent.sh "your prompt"          # One-shot mode
#   ./run-agent.sh --watch                # Live coding watch mode
# ==============================================

set -e
cd "$(dirname "$0")/core/engine/skill_pilot_agent"

# ---- Suppress tracing noise for non-OpenAI keys ----
export OPENAI_AGENTS_DISABLE_TRACING=true

# ---- API Keys (set before running) ----
export DEEPSEEK_API_KEY
export OPENAI_API_KEY
export ANTHROPIC_API_KEY
export GEMINI_API_KEY

if [ -z "$DEEPSEEK_API_KEY" ] && [ -z "$OPENAI_API_KEY" ] && [ -z "$ANTHROPIC_API_KEY" ] && [ -z "$GEMINI_API_KEY" ]; then
  echo "Error: No API key found. Set one of:"
  echo "  export DEEPSEEK_API_KEY=\"sk-...\""
  echo "  export OPENAI_API_KEY=\"sk-...\""
  echo "  export ANTHROPIC_API_KEY=\"sk-ant-...\""
  echo "  export GEMINI_API_KEY=\"...\""
  exit 1
fi

# ---- DEFAULT MODEL ----
MODEL="${SPCODE_MODEL:-deepseek-v4-flash}"

# ---- BUILD IF NEEDED ----
if [ ! -f dist/index.js ]; then
  echo "Building..."
  npm run build
fi

# ---- RUN ----
if [ "$1" = "--watch" ]; then
  shift
  echo "Starting watch mode..."
  exec node dist/index.js --watch --model "$MODEL" --approve-tools no "$@"
elif [ -z "$1" ]; then
  echo "Starting REPL mode..."
  exec node dist/index.js --model "$MODEL"
else
  exec node dist/index.js --model "$MODEL" "$@"
fi
