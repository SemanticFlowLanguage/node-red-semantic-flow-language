// Node-RED plugin entry point (Node.js/server-side)
// Registers AI flow builder HTTP endpoints and serves resources
const getEnv = require('./resources/config-loader')
const axios = require('axios')

let customNodes = []
const summarized = () => customNodes.map(n => ({
  name: n.name,
  fields: Object.keys(n.schema)
}))

module.exports = async function (RED) {
  if (typeof getEnv.setSettings === 'function') {
    getEnv.setSettings(RED.settings)
  }

  // Determine which AI connector to use (default: azure-openai)
  const connectorName = getEnv('AI_CONNECTOR', 'azure-openai')
  // Dynamically load the connector module
  let connector
  const packageInfoCache = new Map()
  const packageInfoCacheUrl = getEnv('PACKAGE_INFO_CACHE_URL', '')
  const packageInfoCacheRaw = getEnv('PACKAGE_INFO_CACHE', [])

  const setPackageInfoCache = arr => {
    arr.forEach(pkgInfo => {
      const { name, description } = pkgInfo

      packageInfoCache.set(name, description)
    })
  }

  const ensurePackageInfoCache = async () => {
    setPackageInfoCache(packageInfoCacheRaw)

    if (packageInfoCacheUrl) {
      try {
        const { data } = await axios.get(packageInfoCacheUrl, { timeout: 5000 })

        setPackageInfoCache(data)
      } catch (e) {
        // continue silently
      }
    }
  }

  await ensurePackageInfoCache()

  try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    connector = require(`./resources/ai-connectors/${connectorName}-connector-node`)
  } catch (e) {
    RED.log.error(`[semantic-flow-language] Failed to load connector "${connectorName}": ${e.message}`)
  }

  const packageInfo = async name => {
    let description = packageInfoCache.get(name) || ''

    if (!description) {
      try {
        // Try npm registry
        const registryRes = await axios.get(`https://registry.npmjs.org/${encodeURIComponent(name)}`, { timeout: 5000 })
        const { data } = registryRes
        const latest = data['dist-tags'] && data['dist-tags'].latest
        const info = latest && data.versions ? data.versions[latest] : data
        const desc = (info && info.description) || data.description || ''

        packageInfoCache.set(name, description)
        description = desc
      } catch (e) {
        // try unpkg fallback
        try {
          const unpkgRes = await axios.get(`https://unpkg.com/${name}/package.json`, { timeout: 5000 })
          const info = unpkgRes.data
          const desc = info && info.description ? info.description : ''

          packageInfoCache.set(name, description)
          description = desc
        } catch (er) {
          // Give up and return empty description
          packageInfoCache.set(name, '')
        }
      }
    }

    return description
  }

  // Receive client-provided custom node metadata
  RED.httpAdmin.post('/ai/custom-nodes', async (req, res) => {
    const { nodes } = req.body || {}

    if (!Array.isArray(nodes)) {
      return res.status(400).json({ success: false, error: 'nodes must be an array' })
    }

    await Promise.all(nodes.map(async n => {
      n.description = await packageInfo(n.packageName)
      delete n.packageName
    }))

    customNodes = nodes
    RED.log.info(`[semantic-flow-language] Stored ${customNodes.length} custom nodes`)

    return res.json({ success: true })
  })

  // Register HTTP endpoint for AI flow generation
  // eslint-disable-next-line consistent-return
  RED.httpAdmin.post('/ai/build-flow', async (req, res) => {
    let output = { success: false, flow: [], error: '' }

    try {
      const { prompt, context = {} } = req.body

      if (!prompt || !prompt.trim()) {
        output.error = 'Prompt is required'

        return res.status(400).json(output)
      }

      // Validate AI configuration
      const aiConfig = connector.getConfig()
      const validation = connector.validateConfig(aiConfig)

      if (!validation.valid) {
        output.error = `AI not configured: ${validation.errors.join(', ')}`

        return res.status(500).json(output)
      }

      context.customNodes = summarized()

      // Generate flow using AI connector
      const result = await connector.generateFlow(prompt, context)

      output = result

      if (result.success) {
        RED.log.info(`[ai-flow-builder] Generated ${result.flow.length} nodes from prompt`)
      } else {
        RED.log.warn(`[ai-flow-builder] Failed: ${result.error}`)
      }

      res.json(output)
    } catch (e) {
      output.error = e.message || 'Internal server error'
      RED.log.error(`[ai-flow-builder] Error: ${e.message}`)
      res.status(500).json(output)
    }
  })

  // Register HTTP endpoint for AI node re-sync
  // eslint-disable-next-line consistent-return
  RED.httpAdmin.post('/ai/resync-node', async (req, res) => {
    let output = { success: false, updatedNode: null, error: '' }

    try {
      const {
        nodeId,
        nodeType,
        nodeName,
        info,
        currentConfig
      } = req.body

      if (!nodeId || !info || !info.trim()) {
        output.error = 'Node ID and info are required'

        return res.status(400).json(output)
      }

      // Validate AI configuration
      const aiConfig = connector.getConfig()
      const validation = connector.validateConfig(aiConfig)

      if (!validation.valid) {
        output.error = `AI not configured: ${validation.errors.join(', ')}`
        return res.status(500).json(output)
      }

      currentConfig.customNodes = summarized()

      // Generate updated node config using AI connector
      const result = await connector.resyncNode(
        nodeId,
        nodeType,
        info,
        currentConfig,
        false,
        nodeName
      )

      output = result

      if (result.success) {
        RED.log.info(`[ai-resync] Re-synced node ${nodeId} based on info change`)
      } else {
        RED.log.warn(`[ai-resync] Failed to re-sync node ${nodeId}: ${result.error}`)
      }

      res.json(output)
    } catch (e) {
      output.error = e.message || 'Internal server error'
      RED.log.error(`[ai-resync] Error: ${e.message}`)
      res.status(500).json(output)
    }
  })

  // Register HTTP endpoint for generating semantic description from logic
  // eslint-disable-next-line consistent-return
  RED.httpAdmin.post('/ai/generate-description', async (req, res) => {
    let output = { success: false, description: '', error: '' }

    try {
      const {
        nodeId,
        nodeType,
        nodeName,
        currentConfig
      } = req.body

      if (!nodeId || !currentConfig) {
        output.error = 'Node ID and config are required'

        return res.status(400).json(output)
      }

      // Validate AI configuration
      const aiConfig = connector.getConfig()
      const validation = connector.validateConfig(aiConfig)

      if (!validation.valid) {
        output.error = `AI not configured: ${validation.errors.join(', ')}`

        return res.status(500).json(output)
      }

      // Generate semantic description using AI connector
      const result = await connector.generateDescription(
        nodeId,
        nodeType,
        currentConfig,
        false,
        nodeName
      )

      output = result

      if (result.success) {
        RED.log.info(`[ai-generate-description] Generated description for node ${nodeId}`)
      } else {
        RED.log.warn(`[ai-generate-description] Failed for node ${nodeId}: ${result.error}`)
      }

      res.json(output)
    } catch (e) {
      output.error = e.message || 'Internal server error'
      RED.log.error(`[ai-generate-description] Error: ${e.message}`)
      res.status(500).json(output)
    }
  })

  // Register plugin with Node-RED
  RED.plugins.registerPlugin('node-red-semantic-flow-language', {
    type: 'node-red-theme',
    scripts: ['node-tooltip.js', 'ai-prompt-sidebar.js']
  })

  RED.log.info('[semantic-flow-language] Plugin registered with AI flow builder endpoint')
}
