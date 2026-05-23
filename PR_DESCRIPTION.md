## Overview
This PR completes the full integration of the Skill Pilot provider, implements a complete ecosystem rebrand to `spcode`, and introduces new dynamic skill-loading features. 

To ensure architectural integrity, no "hacks" were used. The Skill Pilot integration hooks natively into the existing provider and auth configurations, ensuring seamless compatibility with both headless (`exec`) and interactive (`tui`) modes.

## Key Features & Changes

### 1. The `spcode` Rebrand
- **Binary & NPM:** Renamed the Rust binary from `codex` to `spcode`. Updated all `package.json` namespaces to `@skill-pilot/spcode`.
- **Node.js Wrapper:** Renamed the executable wrapper to `bin/spcode.js`.
- **UI & Docs:** Updated all TUI labels, error messages, default `.spcode` home directories, and `README.md` documentation to reflect the new brand.

### 2. Skill Pilot Provider & Auth Routing
- **Environment Detection:** The CLI automatically detects `SKILL_PILOT_BASE_URL`. When set, it disables standard OSS fallback logic and treats Skill Pilot as a primary, authenticated cloud provider.
- **Native Auth Prompt:** Bound `SKILL_PILOT_API_KEY` to the custom provider profile. If the key is missing, the CLI natively prompts the user for it without ever falling back to the OpenAI login screen.
- **Model Parsing:** Routed the Skill Pilot provider through the official `ModelsResponse` parser. This ensures the `/model` TUI command successfully fetches from `http://127.0.0.1:8000/v1/models` and perfectly maps custom reasoning levels (`low`, `medium`, `high`, `xhigh`).
- **SQLite Fix:** Fixed the fallback model slug to strictly use `skill-pilot` to prevent "thread not found" database crashes during headless execution.

### 3. Dynamic Skill Loading
Added two new CLI arguments to both `exec` and TUI modes:
- `--skills-dir <DIR>`: Specifies the directory scanned for `SKILL.md` files (defaults to `<project>/.agent`, falling back to `.agents/skills`).
- `--skills <SKILLS>`: Accepts a comma-separated list of skills to load, `all` (default), or `none` to disable skills entirely.

### 4. Proprietary Skill Pilot Agent
- Created a standalone Node.js/TypeScript agent in `core/engine/skill_pilot_agent/` utilizing `@openai/agents`.
- Added a Bash wrapper at `core/bin/skill-pilot-agent`.
- Configured `config/ai_providers.json5` to route `default.background_llm` tasks to this new agent.

## Acceptance Criteria Checklist
All provided test cases have been verified locally:
- [x] **Test 1:** Fresh install without `SKILL_PILOT_BASE_URL` behaves as vanilla Codex (OpenAI login).
- [x] **Test 2:** Fresh install with URL + Key bypasses OpenAI auth entirely and uses the Skill Pilot backend natively.
- [x] **Test 3:** Fresh install with URL but NO Key natively prompts for `SKILL_PILOT_API_KEY`.
- [x] **Test 4:** Invalid `SKILL_PILOT_API_KEY` throws a connection/auth error without falling back to OpenAI.
- [x] **Test 5:** Existing OpenAI logins are completely ignored when `SKILL_PILOT_BASE_URL` is active.
- [x] **Test 6:** `/models` command fetches directly from the Skill Pilot API and accurately displays all custom models and reasoning efforts.
- [x] **Test 7:** Seamlessly switches between OpenAI and Skill Pilot modes based purely on the presence of the environment variable.
- [x] **Test 8:** Unreachable URLs throw clear connection errors without triggering OpenAI fallbacks.
