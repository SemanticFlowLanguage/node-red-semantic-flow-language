// Anthropic (Claude) Connector - Node.js version
// Server-side implementation using axios
const axios = require('axios')
const getEnv = require('../config-loader')
const ConnectorUtils = require('./connector-utils')

const AnthropicConnector = {
  name: 'anthropic',

  getConfig() {
    return {
      apiKey: getEnv('AI_API_KEY'),
      model: getEnv('AI_MODEL', 'claude-3-5-sonnet-20241022'),
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

  addTokens(config, body, fallbackMax) {
    const tokenSetting = config.maxCompletionTokens || config.maxTokens || fallbackMax

    if (tokenSetting) {
      body.max_tokens = Number(tokenSetting)
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

    const endpoint = 'https://api.anthropic.com/v1/messages'

    const body = {
      model: config.model,
      max_tokens: 4000,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7
    }

    this.addTokens(config, body, 4000)

    try {
      const response = await axios.post(endpoint, body, {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01'
        }
      })

      const content = response.data.content[0]?.text

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
        usage: response.data.usage,
        model: response.data.model,
        stopReason: response.data.stop_reason
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

  async resyncNode(nodeId, nodeType, info, currentConfig, configOverride, customNodes, nodeName = '') {
    const config = configOverride || this.getConfig()
    const output = {
      success: false,
      updatedNode: null,
      error: ''
    }

    const systemPrompt = this.buildSystemPrompt('node')
    const prompt = this.setPlaceholders(NODE_SEMANTIC_UPDATE_PROMPT, {
      nodeType,
      nodeId,
      nodeName: nodeName || '',
      info,
      currentConfig: JSON.stringify(currentConfig, null, 2)
    })

    const endpoint = 'https://api.anthropic.com/v1/messages'

    const body = {
      model: config.model,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [
        { role: 'user', content: prompt }
      ],
      temperature: 0.3
    }

    this.addTokens(config, body, 2000)

    try {
      const response = await axios.post(endpoint, body, {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01'
        }
      })

      const content = response.data.content[0]?.text

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
      const systemPrompt = ConnectorUtils.buildSystemPrompt(currentConfig, 'node')
      const prompt = ConnectorUtils.setPlaceholders(ConnectorUtils.DESCRIPTION_GENERATION_PROMPT, {
        nodeType,
        nodeId,
        nodeName: nodeName || '',
        currentConfig: JSON.stringify(currentConfig, null, 2)
      })

      const body = {
        model: config.model,
        max_tokens: 500,
        temperature: 0.3,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }]
      }

      this.addTokens(config, body, 500)

      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        body,
        {
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.apiKey,
            'anthropic-version': '2023-06-01'
          }
        }
      )

      const content = response.data?.content?.[0]?.text || ''

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
  }
}

// expose ConnectorUtils helpers on the connector for tests/consumers
// preserve connector-specific serializeFlowContext if present
// attach ConnectorUtils helpers when missing (include serializeFlowContext)
Object.keys(ConnectorUtils).forEach(key => {
  if (AnthropicConnector[key] === undefined) {
    AnthropicConnector[key] = ConnectorUtils[key]
  }
})

module.exports = AnthropicConnector

// prefer connector-config-aware serializeFlowContext so tests respect env override
AnthropicConnector.serializeFlowContext = function (nodes = []) {
  const config = this.getConfig()
  const max = config && config.maxFlowContextChars ? Number(config.maxFlowContextChars) : undefined
  return ConnectorUtils.serializeFlowContext(nodes, max)
}
