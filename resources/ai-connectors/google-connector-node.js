// Google AI (Gemini) Connector - Node.js version
// Server-side implementation using axios
const axios = require('axios')
const getEnv = require('../config-loader')
const ConnectorUtils = require('./connector-utils')

const GoogleConnector = {
  name: 'google',

  getConfig() {
    return {
      apiKey: getEnv('AI_API_KEY'),
      model: getEnv('AI_MODEL', 'gemini-1.5-pro'),
      maxCompletionTokens: getEnv('AI_MAX_COMPLETION_TOKENS'),
      maxTokens: getEnv('AI_MAX_TOKENS'),
      maxFlowContextChars: getEnv('AI_MAX_FLOW_CONTEXT_CHARS') || 18000
    }
  },

  validateConfig(config) {
    const required = ['apiKey']
    const missing = required.filter(field => !config[field])

    if (missing.length > 0) {
      return {
        valid: false,
        errors: [`Missing required fields: ${missing.join(', ')}`]
      }
    }

    return { valid: true, errors: [] }
  },

  addTokens(config, generationConfig) {
    const tokenSetting = config.maxCompletionTokens || config.maxTokens

    if (tokenSetting) {
      generationConfig.maxOutputTokens = Number(tokenSetting)
    }
  },

  async generateFlow(prompt, context, configOverride) {
    const config = configOverride || this.getConfig()
    const output = {
      success: false,
      flow: [],
      error: '',
      metadata: {}
    }

    const systemPrompt = ConnectorUtils.buildSystemPrompt(context)
    const userPrompt = ConnectorUtils.buildUserPrompt(prompt, context, config.maxFlowContextChars)

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`

    const body = {
      contents: [
        {
          role: 'user',
          parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }]
        }
      ],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 4000,
        responseMimeType: 'application/json'
      }
    }

    this.addTokens(config, body.generationConfig)

    try {
      const response = await axios.post(endpoint, body, {
        headers: {
          'Content-Type': 'application/json'
        }
      })

      const content = response.data.candidates[0]?.content?.parts[0]?.text

      if (!content) {
        output.error = 'No content in response'
        return output
      }

      // Strip markdown code blocks if present
      let cleanContent = content.trim()
      const codeBlockMatch = cleanContent.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/m)
      if (codeBlockMatch) {
        cleanContent = codeBlockMatch[1].trim()
      }

      let parsed
      try {
        parsed = JSON.parse(cleanContent)
      } catch (parseError) {
        output.error = `AI returned invalid JSON. Response preview: ${content.substring(0, 200)}`
        return output
      }

      output.success = true
      output.flow = parsed.flow || []
      output.flowName = parsed.flowName || ''
      output.metadata = {
        usage: response.data.usageMetadata,
        model: config.model
      }
    } catch (e) {
      if (e.response) {
        output.error = e.response.data?.error?.message || `HTTP ${e.response.status}`
      } else if (e.request) {
        output.error = 'No response from server - check network connection'
      } else {
        output.error = e.message || 'Failed to generate flow'
      }
    }

    return output
  },

  async resyncNode(nodeId, nodeType, info, currentConfig, configOverride, nodeName = '') {
    const config = configOverride || this.getConfig()
    const output = {
      success: false,
      updatedNode: null,
      error: ''
    }

    const systemPrompt = this.buildSystemPrompt('node')
    const userPrompt = this.setPlaceholders(NODE_SEMANTIC_UPDATE_PROMPT, {
      nodeType,
      nodeId,
      nodeName: nodeName || '',
      info,
      currentConfig: JSON.stringify(currentConfig, null, 2)
    })

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`

    const body = {
      contents: [
        {
          role: 'user',
          parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }]
        }
      ],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 2000,
        responseMimeType: 'application/json'
      }
    }

    this.addTokens(config, body.generationConfig)

    try {
      const response = await axios.post(endpoint, body, {
        headers: {
          'Content-Type': 'application/json'
        }
      })

      const content = response.data.candidates[0]?.content?.parts[0]?.text

      if (!content) {
        output.error = 'No content in response'
        return output
      }

      // Strip markdown code blocks if present
      let cleanContent = content.trim()
      const codeBlockMatch = cleanContent.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/m)
      if (codeBlockMatch) {
        cleanContent = codeBlockMatch[1].trim()
      }

      let parsed
      try {
        parsed = JSON.parse(cleanContent)
      } catch (parseError) {
        output.error = `AI returned invalid JSON. Response preview: ${content.substring(0, 200)}`
        return output
      }

      output.success = true
      output.updatedNode = parsed
    } catch (e) {
      if (e.response) {
        output.error = e.response.data?.error?.message || `HTTP ${e.response.status}`
      } else if (e.request) {
        output.error = 'No response from server - check network connection'
      } else {
        output.error = e.message || 'Failed to resync node'
      }
    }

    return output
  },

  async generateDescription(nodeId, nodeType, currentConfig, configOverride, nodeName = '') {
    const config = configOverride || this.getConfig()
    const output = {
      success: false,
      name: '',
      description: '',
      error: ''
    }

    try {
      const systemPrompt = this.buildSystemPrompt('node')
      const prompt = this.setPlaceholders(DESCRIPTION_GENERATION_PROMPT, {
        nodeType,
        nodeId,
        nodeName: nodeName || '',
        currentConfig: JSON.stringify(currentConfig, null, 2)
      })

      const body = {
        contents: [
          {
            role: 'user',
            parts: [{ text: `${systemPrompt}\n\n${prompt}` }]
          }
        ],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 500,
          responseMimeType: 'application/json'
        }
      }

      this.addTokens(config, body.generationConfig)

      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`,
        body,
        {
          headers: {
            'Content-Type': 'application/json'
          }
        }
      )

      const content = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || ''

      if (!content) {
        output.error = 'No description in response'
        return output
      }

      let cleanContent = content.trim()
      const codeBlockMatch = cleanContent.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/m)
      if (codeBlockMatch) {
        cleanContent = codeBlockMatch[1].trim()
      }

      let parsed
      try {
        parsed = JSON.parse(cleanContent)
      } catch (parseError) {
        output.error = `AI returned invalid JSON. Response preview: ${cleanContent.substring(0, 200)}`
        return output
      }

      if (!parsed.description || !parsed.name) {
        output.error = 'AI response missing name or description'
        return output
      }

      output.success = true
      output.name = parsed.name.trim()
      output.description = parsed.description.trim()
    } catch (e) {
      if (e.response) {
        output.error = e.response.data?.error?.message || `HTTP ${e.response.status}`
      } else if (e.request) {
        output.error = 'No response from server - check network connection'
      } else {
        output.error = e.message || 'Failed to generate description'
      }
    }

    return output
  },

  buildSystemPrompt(type = 'flow') {
    return this.setPlaceholders(
      type === 'flow'
        ? SYSTEM_PROMPT_FLOW
        : SYSTEM_PROMPT_NODE,
      { SYSTEM_PROMPT }
    )
  },

  buildUserPrompt(prompt, context) {
    if (context && context.nodes && context.nodes.length > 0) {
      const existingFlow = this.serializeFlowContext(context.nodes)

      return this.setPlaceholders(USER_PROMPT_WITH_CONTEXT, {
        prompt,
        nodeCount: context.nodes.length,
        existingFlow,
        customNodes: context.customNodes
      })
    }

    return this.setPlaceholders(USER_PROMPT_TEMPLATE, { prompt })
  },

  serializeFlowContext(nodes = []) {
    const json = JSON.stringify(nodes, null, 2)
    const config = this.getConfig()

    if (json.length <= config.maxFlowContextChars) {
      return json
    }

    const ratio = config.maxFlowContextChars / json.length
    const keepCount = Math.max(1, Math.floor(nodes.length * ratio))
    const trimmed = nodes.slice(0, keepCount)
    const trimmedJson = JSON.stringify(trimmed, null, 2)

    return `${trimmedJson}\n\n/* NOTE: Flow truncated for context. Showing ${keepCount} of ${nodes.length} nodes. Preserve structure of unseen nodes. */`
  }
}

// expose ConnectorUtils helpers on the connector for tests/consumers
// but keep connector-specific serializeFlowContext
Object.keys(ConnectorUtils).forEach(key => {
  if (key === 'serializeFlowContext') return
  if (GoogleConnector[key] === undefined) {
    GoogleConnector[key] = ConnectorUtils[key]
  }
})

module.exports = GoogleConnector
