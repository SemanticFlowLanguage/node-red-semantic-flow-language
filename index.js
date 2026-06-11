// Node-RED plugin entry point (Node.js/server-side)
// Registers AI flow builder HTTP endpoints and serves resources
const axios = require('axios')
const getEnv = require('./resources/config-loader')
const audit = require('./resources/audit')

let customNodes = []
const summarized = () => customNodes.map(n => ({
  name: n.name,
  fields: Object.keys(n.schema)
}))

// Auto-deploy gate: NODE_ENV must be set AND not "production".
// Blank/undefined fails closed — blank NODE_ENV means unknown environment,
// and unknown should not deploy. Enabling the auto-verify switch is itself
// the user's consent to deploy, so no second flag is required.
const isAutoDeployAllowed = () => {
  const nodeEnv = process.env.NODE_ENV

  if (!nodeEnv || nodeEnv === 'production') {
    return false
  }

  return true
}

const getAutoVerifySettings = () => ({
  autoVerifyDefault: getEnv('SFL_AUTO_VERIFY_DEFAULT', true),
  maxAttempts: getEnv('SFL_AUTO_VERIFY_MAX_ATTEMPTS', 3),
  maxRestarts: getEnv('SFL_AUTO_VERIFY_MAX_RESTARTS', 3),
  timeoutMs: getEnv('SFL_AUTO_VERIFY_TIMEOUT_MS', 60000),
  canAutoDeploy: isAutoDeployAllowed()
})

module.exports = async function (RED) {
  if (typeof getEnv.setSettings === 'function') {
    getEnv.setSettings(RED.settings)
  }

  audit.setRED(RED)

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

      // Generate a prompt_id that scopes all subsequent audit events for this
      // prompt (auto_verify_attempt, auto_verify_complete). Returned to the
      // client so it can include it in events it emits from the verify loop.
      const promptId = audit.generatePromptId()

      audit.emit({
        event_type: 'prompt_received',
        prompt_id: promptId,
        prompt_text: prompt,
        ai_mode: 'flow_generation'
      }, req)

      context.customNodes = summarized()

      // Generate flow using AI connector
      const result = await connector.generateFlow(prompt, context)

      output = result
      output.promptId = promptId

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

      audit.emit({
        event_type: 'prompt_received',
        prompt_id: audit.generatePromptId(),
        prompt_text: info,
        ai_mode: 'node_update'
      }, req)

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

      audit.emit({
        event_type: 'prompt_received',
        prompt_id: audit.generatePromptId(),
        prompt_text: `(generate-description for ${nodeType} ${nodeId})`,
        ai_mode: 'description_generation'
      }, req)

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

  // Returns auto-verify settings + auto-deploy gate result to the editor.
  RED.httpAdmin.get('/ai/auto-verify/settings', (req, res) => {
    res.json({ success: true, settings: getAutoVerifySettings() })
  })

  // Self-correction endpoint: takes the current (failing) flow, the correction
  // diff, and the error summary; asks the AI for a corrected flow.
  // The AI's "existing flow context" is built ONLY from currentFlow — we do not
  // accept (and do not look at) any other client-supplied flow context, so the
  // model never sees unrelated tabs from the user's project.
  // eslint-disable-next-line consistent-return
  RED.httpAdmin.post('/ai/auto-verify/correct', async (req, res) => {
    let output = { success: false, flow: [], error: '' }

    try {
      const {
        prompt = '',
        currentFlow = [],
        correctionDiff = '',
        errorSummary = '',
        errorSignature = '',
        attemptNumber = 1,
        phase = ''
      } = req.body || {}

      if (!errorSummary && !correctionDiff) {
        output.error = 'errorSummary or correctionDiff is required'

        return res.status(400).json(output)
      }

      const aiConfig = connector.getConfig()
      const validation = connector.validateConfig(aiConfig)

      if (!validation.valid) {
        output.error = `AI not configured: ${validation.errors.join(', ')}`

        return res.status(500).json(output)
      }

      const correctionContext = {
        nodes: Array.isArray(currentFlow) ? currentFlow : [],
        customNodes: summarized()
      }

      const correctionRules = getEnv('AUTO_VERIFY_CORRECTION_PROMPT', '')
        .replace(/\{customNodes\}/g, JSON.stringify(summarized()))
        .replace(/\{CUSTOM_NODES\}/g, getEnv('CUSTOM_NODES', ''))

      // The failing flow is fed to the AI via correctionContext.nodes — which
      // the connector's buildUserPrompt() embeds via USER_PROMPT_WITH_CONTEXT.
      // Don't duplicate it here; just give the model the rules + error context.
      // `phase` tells the AI whether this is a static syntax fix (required
      // fields, JSONata syntax, wires, config refs) or a runtime fix (errors
      // emitted by the running flow).
      const correctionPrompt = [
        correctionRules,
        '',
        'CORRECTION CONTEXT',
        `ORIGINAL USER REQUEST: ${prompt || '(not provided)'}`,
        `PHASE: ${phase || 'unspecified'}`,
        `ATTEMPT NUMBER: ${attemptNumber}`,
        `ERROR SIGNATURE: ${errorSignature || '(none)'}`,
        '',
        `ERROR SUMMARY:\n${errorSummary || '(none)'}`,
        '',
        `CORRECTION DIFF (changes between the prior attempt and this attempt):\n${correctionDiff || '(none)'}`
      ].join('\n')

      const result = await connector.generateFlow(correctionPrompt, correctionContext)

      output = result

      if (result.success) {
        RED.log.info(`[ai-auto-verify] Correction attempt ${attemptNumber} returned ${result.flow.length} nodes`)
      } else {
        RED.log.warn(`[ai-auto-verify] Correction attempt ${attemptNumber} failed: ${result.error}`)
      }

      res.json(output)
    } catch (e) {
      output.error = e.message || 'Internal server error'
      RED.log.error(`[ai-auto-verify] Error: ${e.message}`)
      res.status(500).json(output)
    }
  })

  // Audit event sink for the client-driven auto-verify loop. Server stamps the
  // user identity FRESH on each arrival (per spec) before routing through the
  // audit module. Fire-and-forget: respond immediately, never block the client.
  // eslint-disable-next-line consistent-return
  RED.httpAdmin.post('/ai/audit/event', (req, res) => {
    const body = req.body || {}
    const allowedTypes = new Set([
      'prompt_received',
      'auto_verify_attempt',
      'auto_verify_complete'
    ])

    if (!body.event_type || !allowedTypes.has(body.event_type)) {
      return res.status(400).json({ success: false, error: 'invalid event_type' })
    }

    audit.emit(body, req)
    res.json({ success: true })
  })

  // Register plugin with Node-RED
  RED.plugins.registerPlugin('node-red-semantic-flow-language', {
    type: 'node-red-theme'
  })

  await ensurePackageInfoCache()

  RED.log.info('[semantic-flow-language] Plugin registered with AI flow builder endpoint')
}
