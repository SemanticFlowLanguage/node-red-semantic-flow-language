# Node-RED Semantic Flow Language (SFL)
> The first implementation of the **Semantic Flow Language**, bringing bidirectional semantic synchronization and natural-language flow creation to Node-RED.

![SFL Node-RED Demo](./assets/sfl-demo.gif)

## Overview

This plugin extends Node-RED with **Semantic Flow Language (SFL)** features — enabling **AI-assisted flow creation**, **semantic sync between intent and logic**, and **inline editable tooltips** for clarity and transparency.

For the full concept, specification, and philosophy, visit the main project: [Semantic Flow Language Repository](https://github.com/SemanticFlowLanguage/semantic-flow-language))

## Features

- **Natural-Language Flow Builder**
  Describe complete flows in plain English. For example: _"Create an app that pulls today's Zendesk tickets at 7 AM and emails a report."_ AI translates your intent into valid Node-RED JSON automatically.

- **Inline Node Tooltips**
  - Hover to view node descriptions
  - Click to edit inline (content-editable)
  - Save or cancel with overlay buttons
  - Respects Node-RED themes and CSS

- **Semantic Sync Engine**
  - Keeps node `info` (intent) and logic aligned
  - Blue-dot indicators for updated nodes
  - 429 rate-limit handling with exponential backoff
  - Never blocks deploy — errors are logged via kjantan-logger

- **Native Integration**   
  - Uses Node-RED event system (`node:added`, `node:changed`, `deploy`)  
  - No server patching required   
  - Works with all approved nodes from `stack.js`

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
pnpm add git+https://github.com/node-red-semantic-flow-language/node-red-semantic-flow-language.git
```

## Configuration

### Disclaimer

The Semantic Flow Language (SFL) framework is designed to be model-agnostic and compatible with a variety of AI and automation systems.  
However, as of this release, **Google AI**, **OpenAI**, and **Anthropic (Claude)** integrations have **not been formally tested** or validated.  

Any use of SFL with these systems should be considered **experimental** and may require additional configuration or compatibility testing.

### AI Connection Setup

1. **Copy environment template**:
```bash
cp node_modules/node-red-semantic-flow-language/default.env ~/.node-red/.env
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
  AI_EMBEDDING_DEPLOYMENT: ""       // Optional override for Azure AI Search
}
```

## Usage

### Development time Flow Builder Sidebar
1. Click the **🪄Magic Wand** icon.  
2. Describe your flow or logic in natural language.  
3. AJ generates and inserts the corresponding flow JSON.

### Tooltip Editing
1. Hover over a node to view its description.  
2. Click to edit inline.  
3. Click the overlay —Save” button or outside the tooltip to commit.  
4. The node automatically re-syncs.

## About Semantic Flow Language (SFL)

SFL is a **Semantic Execution Model** that represents logic as a **bidirectionally synchronized meaning graph** — permitting human intent, AI generation, and executable code to remain aligned.  
Node-RED serves as the first working implementation of this model.

> Learn more at the *(Semantic Flow Language repository**(https://github.com/SemanticFlowLanguage/semantic-flow-language).

## Related Documentation

- [Concept](hhttps://github.com/SemanticFlowLanguage/semantic-flow-language/blob/main/docs/concept.md)
- [Philosophy](https://github.com/SemanticFlowLanguage/semantic-flow-language/blob/main/philosophy.md)
- [Specification](https://github.com/SemanticFlowLanguage/semantic-flow-language/blob/main/specification.md)
 
### Contact

- **Author:** William Shostak (https://github.com/wshostak)

## License
This project is licensed under the **ISC License** — see the **[LICENSE](./LICENSE.txt)** file for more details.

Copyright (c) 2025 William Shostak
