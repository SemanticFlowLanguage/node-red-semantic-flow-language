// Azure OpenAI Connector - Node.js version
// Server-side implementation using axios
const axios = require('axios')
const getEnv = require('../config-loader')

const USER_PROMPT_TEMPLATE = getEnv('USER_PROMPT_TEMPLATE')
const USER_PROMPT_WITH_CONTEXT = getEnv('USER_PROMPT_WITH_CONTEXT')
const NODE_SEMANTIC_UPDATE_PROMPT = getEnv('NODE_SEMANTIC_UPDATE_PROMPT')
const DESCRIPTION_GENERATION_PROMPT = getEnv('DESCRIPTION_GENERATION_PROMPT')
const SYSTEM_PROMPT = getEnv('SYSTEM_PROMPT')
const SYSTEM_PROMPT_FLOW = getEnv('SYSTEM_PROMPT_FLOW')
const SYSTEM_PROMPT_NODE = getEnv('SYSTEM_PROMPT_NODE')

const AzureOpenAIConnector = {
  name: 'azure-openai',

  getConfig() {
    return {
      endpoint: getEnv('AI_ENDPOINT'),
      apiKey: getEnv('AI_API_KEY'),
      apiVersion: getEnv('AI_API_VERSION') || '2024-12-01-preview',
      deploymentName: getEnv('AI_DEPLOYMENT_NAME'),
      searchEndpoint: getEnv('AI_SEARCH_ENDPOINT'),
      searchApiKey: getEnv('AI_SEARCH_API_KEY'),
      searchIndex: getEnv('AI_SEARCH_INDEX'),
      embeddingDeployment: getEnv('AI_EMBEDDING_DEPLOYMENT'),
      maxCompletionTokens: getEnv('AI_MAX_COMPLETION_TOKENS'),
      maxTokens: getEnv('AI_MAX_TOKENS'),
      maxFlowContextChars: getEnv('AI_MAX_FLOW_CONTEXT_CHARS') || 18000
    }
  },

  addTokens(config, body) {
    if (config.maxCompletionTokens) {
      body.max_completion_tokens = Number(config.maxCompletionTokens)
    } else if (config.maxTokens) {
      body.max_tokens = Number(config.maxTokens)
    }
  },

  setPlaceholders(prompt, values) {
    let result = prompt

    Object.entries(values).forEach(([key, value]) => {
      const placeholder = `{${key}}`
      result = result.replace(new RegExp(placeholder, 'g'), value)
    })

    return result
  },

  validateConfig(config) {
    const required = ['endpoint', 'apiKey', 'deploymentName']
    const missing = required.filter(field => !config[field])

    if (missing.length > 0) {
      return {
        valid: false,
        errors: [`Missing required fields: ${missing.join(', ')}`]
      }
    }

    return { valid: true, errors: [] }
  },

  async generateFlow(prompt, context, configOverride) {
    const config = configOverride || this.getConfig()
    const output = {
      success: false,
      flow: [],
      error: '',
      metadata: {}
    }
    const systemPrompt = this.buildSystemPrompt()
    const userPrompt = this.buildUserPrompt(prompt, context)
    const endpoint = `${config.endpoint.replace(/\/$/, '')}/openai/deployments/${config.deploymentName}/chat/completions?api-version=${config.apiVersion}`
    const body = {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      // temperature: 0.7,
      response_format: { type: 'json_object' }
    }

    this.addTokens(config, body)
    // Add Azure AI Search if configured
    // make sure your apiVersion supports data_sources
    if (config.searchEndpoint && config.searchApiKey && config.searchIndex) {
      body.data_sources = [
        {
          type: 'azure_search',
          parameters: {
            endpoint: config.searchEndpoint,
            index_name: config.searchIndex,
            authentication: {
              type: 'api_key',
              key: config.searchApiKey
            },
            embedding_dependency: config.embeddingDeployment
              ? {
                type: 'deployment_name',
                deployment_name: config.embeddingDeployment
              }
              : undefined,
            query_type: 'vector_simple_hybrid',
            in_scope: true,
            strictness: 3,
            top_n_documents: 5
          }
        }
      ]
    }

    try {
      const response = await axios.post(endpoint, body, {
        headers: {
          'Content-Type': 'application/json',
          'api-key': config.apiKey
        }
      })
      const content = response.data.choices[0]?.message?.content

      if (!content) {
        output.error = 'No content in response'
        return output
      }

      // Strip markdown code blocks if present (```json ... ```)
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
        citations: response.data.choices[0]?.message?.context?.citations
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
    const prompt = this.setPlaceholders(NODE_SEMANTIC_UPDATE_PROMPT, {
      nodeType,
      nodeId,
      nodeName: nodeName || '',
      info,
      currentConfig: JSON.stringify(currentConfig, null, 2)
    })

    const endpoint = `${config.endpoint.replace(/\/$/, '')}/openai/deployments/${config.deploymentName}/chat/completions?api-version=${config.apiVersion}`

    const body = {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      // temperature: 0.3,
      response_format: { type: 'json_object' }
    }

    this.addTokens(config, body)

    try {
      const response = await axios.post(endpoint, body, {
        headers: {
          'Content-Type': 'application/json',
          'api-key': config.apiKey
        }
      })

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
      const systemPrompt = this.buildSystemPrompt('node')
      const prompt = this.setPlaceholders(DESCRIPTION_GENERATION_PROMPT, {
        nodeType,
        nodeId,
        nodeName: nodeName || '',
        currentConfig: JSON.stringify(currentConfig, null, 2)
      })
      const body = {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
        response_format: { type: 'json_object' }
        // temperature: 0.3
      }

      this.addTokens(config, body)

      const response = await axios.post(
        `${config.endpoint}/openai/deployments/${config.deploymentName}/chat/completions?api-version=${config.apiVersion}`,
        body,
        {
          headers: {
            'Content-Type': 'application/json',
            'api-key': config.apiKey
          }
        }
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
        output.error = `AI response missing name or description. Got: ${JSON.stringify(parsed)}`
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

  serializeFlowContext(nodes = []) {
    const json = JSON.stringify(nodes, null, 2)
    const config = this.getConfig()

    if (json.length <= config.maxFlowContextChars) {
      return json
    }

    // crude but effective: scale node count down to fit roughly in the limit
    const ratio = config.maxFlowContextChars / json.length
    const keepCount = Math.max(1, Math.floor(nodes.length * ratio))

    const trimmed = nodes.slice(0, keepCount)

    const trimmedJson = JSON.stringify(trimmed, null, 2)

    // add a small notice so the model knows it's partial
    return `${trimmedJson}\n\n/* NOTE: Flow truncated for context. Showing ${keepCount} of ${nodes.length} nodes. Preserve structure of unseen nodes. */`
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

  buildSystemPrompt(type = 'flow') {
    return this.setPlaceholders(
      type === 'flow'
        ? SYSTEM_PROMPT_FLOW
        : SYSTEM_PROMPT_NODE,
      { SYSTEM_PROMPT }
    )
  }
}

module.exports = AzureOpenAIConnector
