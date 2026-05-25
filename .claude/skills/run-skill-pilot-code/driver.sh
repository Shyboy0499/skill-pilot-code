#!/bin/bash
set -euo pipefail

# Driver for skill-pilot-code — builds and smoke-tests both the spcode Rust CLI
# and the skill-pilot-agent Node.js agent.
#
# Usage:
#   .claude/skills/run-skill-pilot-code/driver.sh          # build + smoke
#   .claude/skills/run-skill-pilot-code/driver.sh --build-only
#   .claude/skills/run-skill-pilot-code/driver.sh --agent-only

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
RUST_DIR="$REPO_ROOT/codex-rs"
AGENT_DIR="$REPO_ROOT/core/engine/skill_pilot_agent"
BIN="$RUST_DIR/target/debug/spcode"
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

pass() { echo -e "${GREEN}PASS${NC} $1"; }
fail() { echo -e "${RED}FAIL${NC} $1"; exit 1; }

BUILD_ONLY=false
AGENT_ONLY=false
[[ "${1:-}" == "--build-only" ]] && BUILD_ONLY=true
[[ "${1:-}" == "--agent-only" ]] && AGENT_ONLY=true

# ---- Build Rust CLI ----
if ! $AGENT_ONLY; then
  echo "==> Building spcode CLI..."
  cd "$RUST_DIR"
  cargo build --bin spcode 2>&1 | tail -1
  test -x "$BIN" || fail "spcode binary not found after build"
  pass "spcode binary built"

  if ! $BUILD_ONLY; then
    echo "==> Smoke-testing spcode..."
    "$BIN" --help > /dev/null 2>&1 || fail "spcode --help failed"
    pass "spcode --help"

    "$BIN" --version > /dev/null 2>&1 || fail "spcode --version failed"
    pass "spcode --version"

    # Verify --skills-dir flag is recognized
    "$BIN" --skills-dir /tmp --help > /dev/null 2>&1 || fail "spcode --skills-dir rejected"
    pass "spcode --skills-dir flag accepted"

    # Verify --skills flag is recognized
    "$BIN" --skills none --help > /dev/null 2>&1 || fail "spcode --skills rejected"
    pass "spcode --skills flag accepted"
  fi
fi

# ---- Build & test Node.js agent ----
if ! $BUILD_ONLY; then
  echo "==> Smoke-testing skill-pilot-agent..."

  # Verify it starts and shows help
  npx ts-node "$AGENT_DIR/src/index.ts" --help 2>&1 | grep -q "Usage:" || fail "agent help not shown"
  pass "agent --help"

  # Verify --skills-dir loads a real skill
  mkdir -p /tmp/test-skill-pilot-skill
  cat > /tmp/test-skill-pilot-skill/SKILL.md << 'SKILLEOF'
---
name: test
description: A test skill
---
You are a test skill.
SKILLEOF

  # Run agent with the test skill, expect it to reach LLM connection stage
  # (connection error is expected — proves skills loaded and agent started)
  OUTPUT=$(npx ts-node "$AGENT_DIR/src/index.ts" --skills-dir /tmp/test-skill-pilot-skill --skills test "hello" 2>&1) || true
  echo "$OUTPUT" | grep -q "Skill Pilot spcode starting session" || fail "agent did not start with --skills-dir"
  pass "agent starts with --skills-dir and --skills"

  # Verify --approve-tools shows in help
  npx ts-node "$AGENT_DIR/src/index.ts" --help 2>&1 | grep -q "approve-tools" || fail "--approve-tools not in help"
  pass "--approve-tools flag present"

  rm -rf /tmp/test-skill-pilot-skill
fi

echo ""
echo "All smoke tests passed."
