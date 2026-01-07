// Shared utilities for AI connectors
const getEnv = require('../config-loader')

const buildPrompts = (template, val = '') => `${getEnv(`${template}_PREPEND`, val)}${getEnv(template, val)}${getEnv(`${template}_APPEND`, val)}`

const CUSTOM_NODES = buildPrompts('CUSTOM_NODES')
const USER_PROMPT_TEMPLATE = buildPrompts('USER_PROMPT_TEMPLATE')
const USER_PROMPT_WITH_CONTEXT = buildPrompts('USER_PROMPT_WITH_CONTEXT')
const NODE_SEMANTIC_UPDATE_PROMPT = buildPrompts('NODE_SEMANTIC_UPDATE_PROMPT')
const DESCRIPTION_GENERATION_PROMPT = buildPrompts('DESCRIPTION_GENERATION_PROMPT')
const SYSTEM_PROMPT = buildPrompts('SYSTEM_PROMPT')
const SYSTEM_PROMPT_FLOW = buildPrompts('SYSTEM_PROMPT_FLOW')
const SYSTEM_PROMPT_NODE = buildPrompts('SYSTEM_PROMPT_NODE')

const ConnectorUtils = {
  CUSTOM_NODES,
  USER_PROMPT_TEMPLATE,
  USER_PROMPT_WITH_CONTEXT,
  NODE_SEMANTIC_UPDATE_PROMPT,
  DESCRIPTION_GENERATION_PROMPT,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_FLOW,
  SYSTEM_PROMPT_NODE,

  setPlaceholders(prompt, values) {
    let result = prompt

    Object.entries(values).forEach(([key, value]) => {
      const placeholder = `{${key}}`
      result = result.replace(new RegExp(placeholder, 'g'), value)
    })

    return result
  },

  serializeFlowContext(nodes = [], maxFlowContextChars = 18000) {
    const json = JSON.stringify(nodes, null, 2)

    if (json.length <= maxFlowContextChars) {
      return json
    }

    // crude but effective: scale node count down to fit roughly in the limit
    const ratio = maxFlowContextChars / json.length
    const keepCount = Math.max(1, Math.floor(nodes.length * ratio))

    const trimmed = nodes.slice(0, keepCount)

    const trimmedJson = JSON.stringify(trimmed, null, 2)

    // add a small notice so the model knows it's partial
    return `${trimmedJson}\n\n/* NOTE: Flow truncated for context. Showing ${keepCount} of ${nodes.length} nodes. Preserve structure of unseen nodes. */`
  },

  buildUserPrompt(prompt, context, maxFlowContextChars = 18000) {
    if (context && context.nodes && context.nodes.length > 0) {
      const existingFlow = this.serializeFlowContext(context.nodes, maxFlowContextChars)

      return this.setPlaceholders(USER_PROMPT_WITH_CONTEXT, {
        prompt,
        nodeCount: context.nodes.length,
        existingFlow,
        customNodes: context.customNodes
      })
    }

    return this.setPlaceholders(USER_PROMPT_TEMPLATE, { prompt })
  },

  buildSystemPrompt(context, type = 'flow') {
    return this.setPlaceholders(
      type === 'flow'
        ? SYSTEM_PROMPT_FLOW
        : SYSTEM_PROMPT_NODE,
      { SYSTEM_PROMPT, CUSTOM_NODES, customNodes: JSON.stringify(context.customNodes || {}) }
    )
  }
}

module.exports = ConnectorUtils
