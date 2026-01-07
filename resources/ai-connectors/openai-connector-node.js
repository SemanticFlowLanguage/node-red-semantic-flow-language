// OpenAI Connector - Node.js version
// Server-side implementation using axios
const axios = require('axios')
const getEnv = require('../config-loader')
const ConnectorUtils = require('./connector-utils')

const OpenAIConnector = {
  name: 'openai',

  getConfig() {
    return {
      apiKey: getEnv('AI_API_KEY'),
      model: getEnv('AI_MODEL', 'gpt-4o'),
      organization: getEnv('AI_ORGANIZATION'),
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

  addTokens(config, body) {
    const NEW_STYLE_PREFIXES = [
      'gpt-4.1',
      'gpt-4o',
      'gpt-5'
    ]
    const isNewStyle = NEW_STYLE_PREFIXES.some(prefix => config.model.startsWith(prefix))
    const maxTokenSetting = config.maxCompletionTokens || config.maxTokens

    if (!maxTokenSetting) {
      return
    }

    const tokenValue = Number(maxTokenSetting)

    if (isNewStyle) {
      body.max_completion_tokens = tokenValue
    } else {
      body.max_tokens = tokenValue
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

    const endpoint = 'https://api.openai.com/v1/chat/completions'

    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`
    }

    if (config.organization) {
      headers['OpenAI-Organization'] = config.organization
    }

    const body = {
      model: config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      response_format: { type: 'json_object' }
    }

    this.addTokens(config, body)

    try {
      const response = await axios.post(endpoint, body, { headers })

      const content = response.data.choices[0]?.message?.content

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
        model: response.data.model
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
    const systemPrompt = ConnectorUtils.buildSystemPrompt(currentConfig, 'node')
    const prompt = ConnectorUtils.setPlaceholders(ConnectorUtils.NODE_SEMANTIC_UPDATE_PROMPT, {
      nodeType,
      nodeId,
      nodeName: nodeName || '',
      info,
      currentConfig: JSON.stringify(currentConfig, null, 2)
    })

    const endpoint = 'https://api.openai.com/v1/chat/completions'

    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`
    }

    if (config.organization) {
      headers['OpenAI-Organization'] = config.organization
    }

    const body = {
      model: config.model,
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' }
    }

    this.addTokens(config, body)

    try {
      const response = await axios.post(endpoint, body, { headers })

      const content = response.data.choices[0]?.message?.content

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

      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      }

      if (config.organization) {
        headers['OpenAI-Organization'] = config.organization
      }

      const body = {
        model: config.model,
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          { role: 'user', content: prompt }
        ],
        response_format: { type: 'json_object' }
      }

      this.addTokens(config, body)

      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        body,
        { headers }
      )

      const content = response.data?.choices?.[0]?.message?.content || ''

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
Object.keys(ConnectorUtils).forEach(key => {
  if (OpenAIConnector[key] === undefined) {
    OpenAIConnector[key] = ConnectorUtils[key]
  }
})

module.exports = OpenAIConnector

// prefer connector-config-aware serializeFlowContext for truncation limits
OpenAIConnector.serializeFlowContext = function (nodes = []) {
  const config = this.getConfig()
  const max = config && config.maxFlowContextChars ? config.maxFlowContextChars : undefined
  return ConnectorUtils.serializeFlowContext(nodes, max)
}
