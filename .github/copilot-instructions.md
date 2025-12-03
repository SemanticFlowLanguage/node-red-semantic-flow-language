# Node-RED Semantic Flow Language - AI Coding Instructions

## Project Overview
A Node-RED editor plugin system providing AI-powered tooltips and natural language flow builder. Two independent client-side plugins load into Node-RED's browser editor: `node-tooltip.js` (interactive inline editing) and `ai-prompt-sidebar.js` (AI flow builder UI).

**Status**: ✅ Successfully packaged and fully operational

## Architecture

### CRITICAL: Editor Plugin Pattern (.html not .js)
Node-RED editor plugins **MUST use .html files** for browser-side registration. This is THE key distinction:

- **Editor plugins** (browser): `.html` file with `<script>` tag containing `RED.plugins.registerPlugin()`
- **Runtime plugins** (Node.js): `.js` file loaded server-side

**Source**: [Japanese Qiita article](https://qiita.com/k-toumura/items/9131b4a7cbce66cc088b) - this was the breakthrough documentation that solved all loading issues.

### Plugin Registration Pattern
`package.json` configuration:
```json
"node-red": {
  "plugins": {
    "semantic-flow-language": "plugin.html"
  }
}
```

`plugin.html` structure:
```html
<script type="text/javascript">
   RED.plugins.registerPlugin("node-red-semantic-flow-language", {
       type: "semantic-flow-language",
       onadd: function() {
           console.log('[semantic-flow-language] Plugin loaded');
           loadDependencies();
           loadPluginScripts();
       }
   });
</script>
```

### Resource Auto-Serving
The `/lib/` directory scripts are automatically served by Node-RED's plugin system.

No `settings.js` modifications needed - plugin is auto-discovered via `package.json`.

### File Structure
```
plugin.html          # Browser-side plugin registration (MUST be .html)
index.js             # Server-side HTTP endpoints + plugin registration
lib/                 # Scripts and supporting modules
  ├── node-tooltip.js         (453 lines - browser-loaded)
  ├── ai-prompt-sidebar.js    (271 lines - browser-loaded with AI integration)
  └── ai-connectors/
      ├── base-connector.js              (Interface)
      └── azure-openai-connector-node.js (Node.js)
configs/             # Configuration files (served via index.js route)
  └── ai-prompts.json         (AI prompt templates - CAPITAL_SNAKE_CASE keys)
package.json         # npm module with "node-red.plugins" config
.env.example         # Azure OpenAI configuration template
```

**Critical**: 
- All supporting files go in `/lib/`
- Config files use CAPITAL_SNAKE_CASE keys and are loaded via node-config

## Successful Console Output
When properly loaded, browser console shows this sequence:
```
[semantic-flow-language] Plugin loaded
[node-tooltip] Plugin loaded
[semantic-flow-language] Tooltip plugin loaded
[ai-prompt-sidebar] Plugin loaded
[semantic-flow-language] Sidebar plugin loaded
[node-tooltip] Popper.js loaded
[node-tooltip] Tippy.js loaded
[ai-prompt-sidebar] Sidebar initialized
[node-tooltip] Workspace observer initialized
```

## Development Standards

### Code Style
- **No semicolons** unless required by grammar
- **Single returns**: Initialize default `output`, mutate inside conditionals, return once
- **Use `let` for primitives that will be reassigned, `const` for objects/arrays that will be mutated**
- **Object-first modules**: Wrap related functions in an object literal rather than scattered function assignments
- **No `null`/`undefined` in model**: Omit properties instead; use safe defaults (`[]`, `{}`, `0`, `''`)
- **Braces required**: Always use `{}` for `if`/`else`/`for`/`while`, even single lines
- **Comments**: `//` for ≤3 lines, `/* */` for 4+ lines
- **Spacing**: Single blank lines between logical blocks; no double-spacing

### Object & Function Patterns
```javascript
// Preferred: Object-first module pattern
const UserService = {
  async fetchUser(id) {
    const output = { success: false, user: {}, error: '' }
    
    try {
      const res = await api.get(`/users/${id}`)
      output.success = true
      output.user = res.data
    } catch (e) {
      output.error = e.message
    }
    
    return output
  },
  
  validateEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  }
}

// Preferred: Pure objects with methods
const tooltip = {
  value: '',
  update(text) { this.value = text },
  clear() { this.value = '' }
}

// Preferred: Default-first single return with primitives (use let)
function getContent(node) {
  let output = 'Default content'
  
  if (node.info) {
    output = stripMarkdown(node.info)
  } else if (node.name) {
    output = node.name
  }
  
  return output
}

// Preferred: Objects/arrays (use const, mutate properties)
async function generateFlow(prompt, config) {
  const output = { success: false, flow: [], error: '' }
  
  try {
    const result = await ai.generate(prompt, config)
    output.success = true
    output.flow = result.nodes
  } catch (e) {
    output.error = e.message
  }
  
  return output
}
```

**Avoid**: 
- Classes (unless required like `HTMLElement`)
- Multiple returns in functions
- `null` assignments in internal model
- Scattered function assignments (prefer object literal modules)

Example anti-pattern:
```javascript
// ❌ Avoid scattered function assignments
const MyService = {}
MyService.fetchData = async function() { /* ... */ }
MyService.validate = function() { /* ... */ }

// ✅ Prefer object literal
const MyService = {
  async fetchData() { /* ... */ },
  validate() { /* ... */ }
}
```

## Key Components

### 1. Node Tooltip Plugin (`lib/node-tooltip.js`)
**Purpose**: Hover tooltips that become editable inline editors for node descriptions

**Core Flow**:
1. Loads Tippy.js via CDN injection
2. Listens to `RED.events` (`editor:open`, `nodes:change`, `workspace:change`)
3. Creates Tippy instance per node from `node.info` (markdown) → stripped preview
4. Click tooltip → enters edit mode with overlay + green glow
5. Save: Click overlay/Ctrl+Enter | Discard: Esc/× button
6. Updates `node.info` and marks flow dirty via `RED.nodes.dirty(true)`

**Key Functions**:
- `stripMarkdown()`: Converts markdown to plain text (3-line preview)
- `enterEditMode()`: Shows overlay, makes content editable, adds close button
- `saveAndExitEditMode()`: Commits to `node.info`, emits `nodes:change`
- `observeWorkspace()`: MutationObserver for dynamically added nodes

**State Management**: `Map` of Tippy instances keyed by `node.id`

### 2. AI Prompt Sidebar (`lib/ai-prompt-sidebar.js`)
**Purpose**: Sticky sidebar panel for natural language flow generation (UI only)

**Core Features**:
- Registers as first sidebar tab with magic wand icon (🪄)
- Non-closeable, opens by default
- Textarea for flow descriptions
- **TODO**: Backend integration needed (`/api/ai/build-flow`)

**Integration Points** (mock implementation):
```javascript
// Expected flow:
// 1. POST prompt + current flow to AI endpoint
// 2. Receive Node-RED flow JSON
// 3. Import via RED.nodes.import(flowJson)
// 4. Redraw workspace: RED.view.redraw()
```

## Node-RED API Patterns

### Events
```javascript
RED.events.on('editor:open', callback)      // Editor tab opened
RED.events.on('nodes:change', node => {})   // Node modified
RED.events.on('workspace:change', () => {}) // Tab switch
```

### Node Operations
```javascript
RED.nodes.eachNode(callback)                // Iterate all nodes
RED.nodes.node(nodeId)                      // Get node by ID
RED.nodes.dirty(true)                       // Mark flow modified
RED.nodes.import(flowJson)                  // Add flow to workspace
RED.view.redraw()                           // Refresh canvas
```

### Sidebar Registration
```javascript
RED.sidebar.addTab({
  id: 'unique-id',
  label: 'Tab Label',
  content: $('<div>'),  // jQuery element
  closeable: false,     // Sticky tab
  iconClass: 'fa fa-icon',
  order: -1             // First position (leftmost)
})
```

## Development Workflows

### Local Testing
```bash
# Install in Node-RED
cd ~/.node-red
pnpm add file:/path/to/node-red-semantic-flow-language

# Or use yarn link for active development
cd /path/to/node-red-semantic-flow-language
yarn link

cd ~/.node-red
yarn link node-red-semantic-flow-language

# Restart Node-RED to reload plugins
```

**No Configuration Required**: Plugin is auto-discovered via `package.json`. No `settings.js` modifications needed.

**Version Compatibility**: Requires Node-RED >= 3.0.0 (tested with v4.1.1)

### Testing Commands
- `pnpm test` - Runs Jest (currently minimal tests)
- `pnpm run coverage` - Coverage for CI/CD (GitLab)

**Note**: No tests currently exist. Browser-side plugins are tested manually in Node-RED editor.

## Common Patterns

### Markdown Handling
All `node.info` fields use markdown. Strip for display:
```javascript
// Remove headers, bold, links, code blocks, lists
output = text
  .replace(/#{1,6}\s+/g, '')
  .replace(/(\*\*|__)(.*?)\1/g, '$2')
  .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
  // ... etc
```

### Theme-Aware Styling
Use Node-RED CSS variables for dark/light theme support:
```css
color: var(--red-ui-primary-text-color, #333);
background: var(--red-ui-form-background, #fff);
border: 1px solid var(--red-ui-form-input-border-color, #ccc);
```

### AI Marker Detection
Nodes generated by AI are marked with diamond symbol `⧫`:
```javascript
const hasAIMarker = (node.name && node.name.includes('⧫')) || 
                    (node.label && node.label.includes('⧫'))
```

## Critical Gotchas

1. **Tippy Instance Lifecycle**: Always destroy old instances before creating new ones to prevent memory leaks
2. **Edit Mode Visibility**: Must override Tippy's `hideOnClick` and force `visibility: visible` during editing
3. **Workspace Observer**: Use MutationObserver to catch dynamically added nodes (drag-drop from palette)
4. **jQuery Required**: Node-RED editor uses jQuery; sidebar content must be jQuery element
5. **Shadow DOM Constraint**: Cannot use Shadow DOM as Node-RED workspace doesn't support it

## Integration TODOs

The AI sidebar is now **fully integrated** with Azure OpenAI:

### Configuration Required

1. **Environment Variables** - Add to `~/.node-red/.env`:
```bash
AI_ENDPOINT='https://your-endpoint.openai.azure.com/'
AI_API_KEY='your-api-key'
AI_DEPLOYMENT_NAME='your-deployment-name'

# Optional: Azure AI Search for RAG
AI_SEARCH_ENDPOINT='https://your-search.search.windows.net/'
AI_SEARCH_API_KEY='your-search-key'
AI_SEARCH_INDEX='your-index-name'
AI_EMBEDDING_DEPLOYMENT='your-embedding-deployment'
```

2. **Install Dependencies**:
```bash
cd /path/to/node-red-semantic-flow-language
pnpm install
```

### Architecture

**Client-Side** (`lib/ai-prompt-sidebar.js`):
- Sends prompt + workspace context to `/ai/build-flow`
- Receives Node-RED flow JSON
- Imports flow via `RED.nodes.import()`
- Shows usage statistics and citations

**Server-Side** (`index.js`):
- Registers `/ai/build-flow` HTTP endpoint via `RED.httpAdmin.post`
- Uses `AzureOpenAIConnector` for AI calls
- Returns `{ success, flow, error, metadata }`

**AI Connector** (`lib/ai-connectors/`):
- `base-connector.js` - Interface contract
- `azure-openai-connector.js` - Browser implementation (uses native fetch)  
- `azure-openai-connector-node.js` - Node.js implementation (uses axios)
- Supports Azure AI Search (RAG) for Node-RED documentation

### Adding New Connectors

1. Create `lib/ai-connectors/your-connector.js`
2. Implement `BaseConnector` interface:
   - `validateConfig(config)` - Returns `{ valid, errors }`
   - `generateFlow(prompt, context, config)` - Returns `{ success, flow, error, metadata }`
3. Update `index.js` to use your connector
4. Add config to `configs/ai-prompts.json` or create new config file

## Debugging

**Browser Console Logs**:
- `[semantic-flow-language] Plugin loaded` - Main plugin initialized
- `[node-tooltip] Tooltip clicked, entering edit mode` - Edit mode triggered
- `[ai-prompt-sidebar] Sidebar initialized` - Sidebar ready

**Common Issues**:
- **Tooltips not appearing**: Check Tippy.js loaded (`typeof tippy !== 'undefined'`)
- **Edits not saving**: Verify `node.info` updated and `RED.nodes.dirty(true)` called
- **Sidebar not visible**: Check `RED.sidebar.show('ai-flow-builder')` called after initialization
