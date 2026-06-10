#!/bin/bash
# ==============================================
# Skill Pilot Agent — Automated Demo Script
# Run: ./demo.sh
# ==============================================
set -e
cd "$(dirname "$0")/core/engine/skill_pilot_agent"

export OPENAI_AGENTS_DISABLE_TRACING=true
export DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-sk-9a03fbda89054ee6812a01e233ad6217}"
MODEL="deepseek-v4-flash"
AGENT="node dist/index.js --model $MODEL"

# ── Build ────────────────────────────────────
echo "==> Building..."
npm run build 2>/dev/null
echo ""

# ── ACT 1: First Impressions ─────────────────
echo "============================================="
echo "  ACT 1: First Impressions"
echo "============================================="
echo ""

echo "--- --help ---"
$AGENT --help 2>/dev/null | head -15
echo ""
sleep 1

echo "--- One-shot: simple question ---"
$AGENT "what is the capital of France? answer in 3 words"
echo ""
sleep 2

echo "--- One-shot: coding task ---"
$AGENT "write a python function that checks if a string is a palindrome"
echo ""
sleep 2

# ── ACT 2: Tools in Action ───────────────────
echo "============================================="
echo "  ACT 2: Tools in Action"
echo "============================================="
echo ""

echo "--- Read file ---"
$AGENT "read package.json and tell me the version"
echo ""
sleep 2

echo "--- Bash execution ---"
$AGENT "use bash to find all .ts files under src/ - type f"
echo ""
sleep 2

echo "--- Web search ---"
$AGENT "use web_search to find the latest TypeScript version"
echo ""
sleep 2

echo "--- Multi-tool: read + edit + verify ---"
echo "hello world" > demo.txt
$AGENT "1. read demo.txt, 2. use edit to replace hello with goodbye, 3. read it again to verify"
echo "--> File contents: $(cat demo.txt)"
rm -f demo.txt
echo ""
sleep 2

# ── ACT 3: Advanced Features ─────────────────
echo "============================================="
echo "  ACT 3: Advanced Features"
echo "============================================="
echo ""

echo "--- Effort: low ---"
$AGENT --effort low "explain recursion in one sentence"
echo ""
sleep 2

echo "--- Effort: xhigh ---"
$AGENT --effort xhigh "explain recursion in one sentence"
echo ""
sleep 2

echo "--- Sandbox ---"
$AGENT "use the sandbox tool to run: echo isolated && pwd"
echo ""
sleep 2

echo "--- Streaming bash ---"
$AGENT "use bash_stream to run: for i in 1 2 3; do echo step \$i; sleep 0.3; done"
echo ""
sleep 2

echo "--- Model suggestion on typo ---"
node dist/index.js --model deepseek-v4-flsh "test" 2>&1 | head -3
echo ""
sleep 1

# ── Closing ─────────────────────────────────
echo "============================================="
echo "  DEMO COMPLETE"
echo "============================================="
echo ""
echo "  51 files | 13 tools | 4 providers | 9 models"
echo "  github.com/Shyboy0499/skill-pilot-code"
echo ""
echo "  REPL mode:  $AGENT"
echo "  Watch mode: $AGENT --watch"
echo ""
