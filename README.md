# Node-RED Semantic Flow Language (SFL)
> The first implementation of the **Semantic Flow Language**, bringing bidirectional semantic synchronization and natural-language flow creation to Node-RED.

![SFL Node-RED Demo](./assets/sfl-demo.gif)

## Overview

This plugin extends Node-RED with **Semantic Flow Language (SFL)** features — enabling **AI-assisted flow creation**, **semantic sync between intent and logic**, and **inline editable tooltips** for clarity and transparency.

For the full concept, specification, and philosophy, visit the main project: [Semantic Flow Language Repository](https://github.com/SemanticFlowLanguage/semantic-flow-language)

## Features

- **Natural-Language Flow Builder**
  Describe complete flows in plain English. For example: _"Create an app that pulls today's Zendesk tickets at 7 AM and emails a report."_ AI translates your intent into valid Node-RED JSON automatically.

- **Auto-Verify with AI Self-Correction**
  When the AI generates or updates a flow, the plugin validates it (schema, node types, required props, wire integrity, config-node refs) and — when explicitly enabled — deploys it to a non-production runtime to watch for errors. Any validation failure or runtime error is fed back to the AI as a correction diff for the next attempt. The loop stops on success, on the configured attempt ceiling, or when the same error signature recurs. See [Auto-Verify](#auto-verify) for configuration.

- **Inline Node Tooltips**
  - Hover to view node descriptions
  - Click to edit inline (content-editable)
  - Save or cancel with overlay buttons
  - Respects Node-RED themes and CSS

- **Semantic Sync Engine**
  - Keeps node `info` (intent) and logic aligned
  - Blue-dot indicators for updated nodes
  - 429 rate-limit handling with exponential backoff

- **Native Integration**   
  - Uses Node-RED event system (`node:added`, `node:changed`, `deploy`)  
  - No server patching required   
  - Works with Node-RED approved nodes

## Visual Indicators

| Color | Meaning |
|-------|----------|
| 🟡 Yellow | Sync in progress |
| 🔴 Red | Rate-limited / retry pending |
| 🔵 Blue | Synced and verified |

## Installation

### Development
```bash
cd ~/.node-red
pnpm add node-red-semantic-flow-language
cd node_modules/node-red-semantic-flow-language
pnpm install
```

### Production
```bash
pnpm add node-red-semantic-flow-language
```

## Configuration

### Disclaimer

The Semantic Flow Language (SFL) framework is designed to be model-agnostic and compatible with a variety of AI and automation systems.  
However, as of this release, **Google AI**, **OpenAI**, and **Anthropic (Claude)** integrations have **not been formally tested** or validated.  

Any use of SFL with these systems should be considered **experimental** and may require additional configuration or compatibility testing.

### AI Connection Setup

1. **Copy environment template**:
```bash
cp node_modules/node-red-semantic-flow-language/.env.example ~/.node-red/.env
```

2. **Edit `~/.node-red/.env`** with your AI provider credentials:
```bash
# Select connector: azure-openai, openai, anthropic, google
AI_CONNECTOR=""

# Shared AI API key (required for all connectors)
AI_API_KEY=""

# Shared AI model (per provider)
AI_MODEL=""

# Token limits and context (optional)
AI_MAX_COMPLETION_TOKENS=1024
AI_MAX_TOKENS=1024
AI_MAX_FLOW_CONTEXT_CHARS=18000

# OpenAI (only when AI_CONNECTOR=openai)
AI_ORGANIZATION=""

# Azure OpenAI (only when AI_CONNECTOR=azure-openai)
AI_ENDPOINT="https://your-endpoint.openai.azure.com/"
AI_API_VERSION="2024-12-01-preview"
AI_DEPLOYMENT_NAME="your-deployment-name"

# Optional: Azure AI Search for RAG (Node-RED documentation)
AI_SEARCH_ENDPOINT="https://your-search.search.windows.net/"
AI_SEARCH_API_KEY="your-search-key"
AI_SEARCH_INDEX="your-index-name"
AI_EMBEDDING_DEPLOYMENT="your-embedding-deployment"

# Auto-Verify (AI tab switch defaults and correction-loop bounds)
SFL_AUTO_VERIFY_DEFAULT="true"
SFL_AUTO_VERIFY_MAX_ATTEMPTS="3"
SFL_AUTO_VERIFY_MAX_RESTARTS="3"
SFL_AUTO_VERIFY_TIMEOUT_MS="30000"
```

3. **Restart Node-RED**:
```bash
node-red-restart
```

> No changes to `settings.js` are required - the plugin is auto-discovered via `package.json`.

### Advanced configuration in `settings.js` (optional)

The plugin is designed so that configuration can live in either `.env` or `settings.js`. Prompt overrides are read from `settings.js` when present. The plugin will work out of the box with only `.env` configured.

Recommendation: keep secrets (for example API keys) in `.env` rather than in `settings.js`. You can override settings in `settings.js` for per-instance tuning, but storing sensitive credentials there is not recommended.

If you want to tune behavior for a specific Node-RED instance, add a small configuration block to your `settings.js`.
```javascript
module.exports = {
  aiPrompts: {
    SYSTEM_PROMPT: "Your custom system prompt here",
    SYSTEM_PROMPT_FLOW: "Your custom system prompt for flow here",
    SYSTEM_PROMPT_NODE: "Your custom system prompt for node here",
    USER_PROMPT_TEMPLATE: "Your custom user prompt template here",
    USER_PROMPT_WITH_CONTEXT: "Your custom user prompt with context here",
    NODE_SEMANTIC_UPDATE_PROMPT: "Your custom node semantic update prompt here",
    DESCRIPTION_GENERATION_PROMPT: "Your custom node description generation prompt here",
  },
  AI_CONNECTOR: "openai",           // Optional override
  AI_MODEL: "gpt-4",                // Optional override
  AI_API_KEY: "",                   // Optional override (not recommended)
  AI_MAX_COMPLETION_TOKENS: 2048,   // Optional override
  AI_MAX_TOKENS: 2048,              // Optional override
  AI_MAX_FLOW_CONTEXT_CHARS: 20000, // Optional override
  AI_ORGANIZATION: "",              // Optional override for OpenAI
  AI_ENDPOINT: "",                  // Optional override for Azure OpenAI
  AI_API_VERSION: "",               // Optional override for Azure OpenAI
  AI_DEPLOYMENT_NAME: "",           // Optional override for Azure OpenAI
  AI_SEARCH_ENDPOINT: "",           // Optional override for Azure AI Search
  AI_SEARCH_API_KEY: "",            // Optional override for Azure AI Search
  AI_SEARCH_INDEX: "",              // Optional override for Azure AI Search
  AI_EMBEDDING_DEPLOYMENT: "",      // Optional override for Azure AI Search

  // Auto-Verify (see the Auto-Verify section below for behavior)
  SFL_AUTO_VERIFY_DEFAULT: true,    // Default state of the AI tab auto-verify switch
  SFL_AUTO_VERIFY_MAX_ATTEMPTS: 3,  // Correction attempts before regenerating from scratch
  SFL_AUTO_VERIFY_MAX_RESTARTS: 3,  // Fresh regenerations to try after inner attempts fail
  SFL_AUTO_VERIFY_TIMEOUT_MS: 30000,// Per-attempt deploy/observation window and loop upper bound

  // Audit (see the Audit Trail section below). Default empty = silent.
  SFL_AUDIT_DESTINATION: "",        // "" | "red.log" | "http(s)://..." | filepath (JSONL)
  SFL_AUDIT_HEADERS: {}             // URL mode only: HTTP headers (key-value object)
}
```

### Auto-Verify

When the AI builds or updates a flow, auto-verify can validate the result, optionally deploy it to a non-production runtime, watch for errors, and feed any failure back to the AI as a correction diff for the next attempt. The correction log is rendered in the existing AI tab output panel; Node-RED's debug panel remains the canonical record of full error fidelity.

**Toggle.** A switch labeled `auto-verify` sits above the response panel in the AI Builder sidebar. Its default state comes from `SFL_AUTO_VERIFY_DEFAULT`.

**Settings** (configurable in `.env` or under the plugin block in `settings.js`):

| Key | Type | Default | Notes |
|---|---|---|---|
| `SFL_AUTO_VERIFY_DEFAULT` | boolean | `true` | Default state of the AI tab switch. |
| `SFL_AUTO_VERIFY_MAX_ATTEMPTS` | integer | `3` | Inner correction attempts within one restart. |
| `SFL_AUTO_VERIFY_MAX_RESTARTS` | integer | `3` | After exhausting attempts, regenerate the flow from scratch (sends the original prompt with no context) and run auto-verify again. Worst-case AI calls = `MAX_ATTEMPTS * MAX_RESTARTS`. |
| `SFL_AUTO_VERIFY_TIMEOUT_MS` | integer | `30000` | Per-attempt deploy/observe window and loop upper bound. |

**Auto-deploy gate.** Turning on the auto-verify switch is the user's explicit consent to deploy, so the only remaining guard is the environment:

- `process.env.NODE_ENV` must be **set** and **not** `"production"`. Blank or undefined fails closed — an unknown environment must not deploy.

If the environment check fails, auto-verify runs **validation-only** (schema, node-type existence, required props, wire integrity, config-node refs) and a clean validation counts as a successful attempt.

**Two-phase self-correction loop.** Each attempt runs two phases in order:

1. **Syntax phase** — uses Node-RED's own per-node validator (the same one that puts the red error triangle on invalid nodes in the editor). Covers required fields, typedInput types, JSONata expression syntax, wire integrity, unknown node types, and unresolved config-node references. If syntax errors are found, the attempt ends here and the next attempt starts again with a syntax check on the AI's correction.
2. **Runtime phase** — only entered when the syntax phase is clean. Deploys the flow (if the auto-deploy gate allows) and observes the Node-RED debug stream for the timeout window. Any runtime errors observed end the attempt.

On either phase failure the plugin:
- captures the error signature (namespaced `syntax:` or `runtime:`),
- computes the correction diff between the previous and current attempt,
- sends the diff + error + phase to the AI for the next attempt.

**Restarts.** If the inner attempts loop hits `SFL_AUTO_VERIFY_MAX_ATTEMPTS` without success (or stops on signature repeat), the plugin **regenerates the flow from scratch** by re-sending the original prompt to the AI with no context. It then runs the inner loop again on the fresh flow. This repeats up to `SFL_AUTO_VERIFY_MAX_RESTARTS` times.

The whole loop stops on: clean syntax + clean runtime, the `SFL_AUTO_VERIFY_MAX_RESTARTS × SFL_AUTO_VERIFY_MAX_ATTEMPTS` ceiling, or repetition of the same error signature within a restart (early convergence stop for that restart). Both phases combined count as one attempt against `SFL_AUTO_VERIFY_MAX_ATTEMPTS`. On stop, the flow is left in its current state in the editor — there is no rollback or stash.

On terminal failure (all restarts exhausted), the AI tab output panel shows:

> Couldn't resolve — try rephrasing prompt and running again. If that also fails, escalate to dev.

### Audit Trail

Plugin activity (prompt receipt, each auto-verify attempt, and the final auto-verify outcome) can be emitted as structured JSON events to a single configurable destination. Default behavior is **silent** — nothing is emitted unless `SFL_AUDIT_DESTINATION` is set. Emission is fire-and-forget; it never blocks the user-facing operation.

**Destination is resolved from `SFL_AUDIT_DESTINATION` in this order:**

| Value | Behavior |
|---|---|
| empty / unset | silent (default) |
| `"red.log"` | emit via `RED.log.info()` with the event as a JSON string |
| starts with `http://` or `https://` | POST JSON payload to that URL |
| anything else | treated as a file path; append as JSONL (one event per line). Relative paths resolve against the Node-RED user directory. |

For URL mode, set `SFL_AUDIT_HEADERS` (object) in `settings.js` to attach auth headers to every POST. TLS is verified by default. Transient failures (timeout, 5xx) are retried once with backoff; pending requests are capped at 100 to prevent backpressure, and excess events are dropped with a `RED.log.warn`.

File mode is append-only, no rotation in v1 — manage with `logrotate` or equivalent.

**Common envelope on every event:** `timestamp` (ISO 8601 with timezone), `event_type`, `user` (best-available: email → username/UPN → id → null), `user_source` (`email` / `username` / `id` / `none`), `prompt_id` (UUID generated when the prompt is received, referenced by all subsequent events). The server stamps `user`/`user_source` fresh on each event write.

**Event types:**

- `prompt_received` — emitted when an AI endpoint accepts a prompt. Extra fields: `prompt_text`, `ai_mode` (`flow_generation` / `node_update` / `description_generation`).
- `auto_verify_attempt` — emitted once per attempt outcome. Extra fields: `attempt_number`, `mode` (`syntax` / `runtime`), `error_signature` (normalized — node ids/UUIDs/timestamps/numbers stripped so equivalent errors hash identically), `error_message` (raw), `correction_summary`, `outcome` (`resolved` / `unresolved` / `same_signature_repeated`).
- `auto_verify_complete` — emitted once when the loop terminates. Extra fields: `outcome` (`resolved` / `ceiling_hit` / `signature_repeated` / `unresolved_after_resample`), `total_attempts`, `resample_triggered` (boolean), `final_flow_id` (target tab id), `duration_ms`.

**Correction log format.** The AI tab output panel shows the attempt count prominently at the top (for example: `Resolved in 2 attempts` or `Stopped after 3 attempts — unresolved`). Each attempt is rendered as a discrete entry labeled `Attempt N · Syntax` or `Attempt N · Runtime` to indicate which phase determined the outcome. The entry contains the attempt number + phase, a one-line error summary, what the AI changed in response, and the phase outcome.

## Usage

### Development time Flow Builder Sidebar
1. Click the **🪄Magic Wand** icon.  
2. Describe your flow or logic in natural language.  
3. AI generates and inserts the corresponding flow JSON.

### Tooltip Editing
1. Hover over a node to view its description.  
2. Click to edit inline.  
3. Click the overlay "Save” button or outside the tooltip to commit.  
4. The node automatically re-syncs.

## About Semantic Flow Language (SFL)

SFL is a **Semantic Execution Model** that represents logic as a **bidirectionally synchronized meaning graph** — permitting human intent, AI generation, and executable code to remain aligned.  
Node-RED serves as the first working implementation of this model.

> Learn more in the [Semantic Flow Language repository](https://github.com/SemanticFlowLanguage/semantic-flow-language).

## Related Documentation

- [Concept](https://github.com/SemanticFlowLanguage/semantic-flow-language/blob/main/docs/concept.md)
- [Philosophy](https://github.com/SemanticFlowLanguage/semantic-flow-language/blob/main/docs/philosophy.md)
- [Specification](https://github.com/SemanticFlowLanguage/semantic-flow-language/blob/main/docs/specification.md)
 
### Contact

- **Author:** William Shostak (https://github.com/wshostak)

## License
This project is licensed under the **ISC License** — see the **[LICENSE](./LICENSE.txt)** file for more details.

Copyright (c) 2025 William Shostak
