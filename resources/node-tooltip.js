/*
  Node-RED Editor Plugin: Node Tooltip with Tippy.js
  Adds interactive tooltip to nodes based on node info/description
  Click tooltip to edit node info inline with overlay
  Part of Semantic Flow Language - Phase 1
*/

(function () {
  const tippyInstances = new Map()

  // Track original semantic info for each node to detect changes
  // Format: { nodeId: { info: "original text", lastSynced: timestamp } }
  window.semanticNodeRegistry = window.semanticNodeRegistry || {}

  // Track functional state to detect logic changes
  // Format: { nodeId: { func: "...", rules: [...], url: "...", etc. } }
  window.nodeFunctionalState = window.nodeFunctionalState || {}

  function stripMarkdown(text) {
    let output = text

    output = output
      .replace(/#{1,6}\s+/g, '')
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(.*?)\1/g, '$2')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      .replace(/\n\n+/g, '\n')
      .replace(/\s+/g, ' ')

    return output
  }

  function createTooltipContent(displayText, rawInfo, node) {
    const div = document.createElement('div')
    div.className = 'node-tooltip-content'
    div.style.whiteSpace = 'pre-wrap'
    div.style.wordWrap = 'break-word'
    div.style.cursor = 'pointer'
    div.textContent = displayText
    div.dataset.rawInfo = rawInfo
    div.dataset.displayText = displayText
    div.dataset.nodeId = node.id

    return div
  }

  function hideEditOverlay() {
    const overlay = document.getElementById('node-tooltip-overlay')
    if (overlay) {
      overlay.style.display = 'none'
    }
  }

  function exitEditMode(content, instance, node, displayText, save) {
    console.log('[node-tooltip] Exiting edit mode, save:', save)
    content.contentEditable = 'false'
    content.style.background = ''
    content.style.padding = ''
    content.textContent = displayText

    instance.popper.classList.remove('red-ui-popover')
    instance.popper.style.zIndex = ''

    const closeBtn = content.parentElement?.querySelector('.tooltip-close-btn')
    if (closeBtn) {
      closeBtn.remove()
    }

    // Reset to normal tooltip behavior - remove the blocking hooks
    instance.setProps({
      trigger: 'mouseenter',
      hideOnClick: true,
      interactive: true
    })

    hideEditOverlay()
    instance.hide()
  }

  function setNodeSyncStatus(nodeId, status) {
    const nodeElement = document.getElementById(nodeId)
    if (!nodeElement) {
      return
    }

    const portCircle = nodeElement.querySelector('.red-ui-flow-node-changed circle')
    if (portCircle) {
      // eslint-disable-next-line no-nested-ternary
      const resolvedStatus = typeof status === 'boolean' ? (status ? 'syncing' : 'idle') : status
      const styles = {
        syncing: { fill: '#ffd200', stroke: '#b8860b' },
        waiting: { fill: '#f44336', stroke: '#8b0000' }
      }

      if (styles[resolvedStatus]) {
        portCircle.style.fill = styles[resolvedStatus].fill
        portCircle.style.stroke = styles[resolvedStatus].stroke
      } else {
        portCircle.style.fill = ''
        portCircle.style.stroke = ''
      }
    }
  }

  function getNodeWiresFromLinks(nodeId) {
    const outputs = []
    RED.nodes.eachLink(link => {
      if (link.source && link.source.id === nodeId) {
        const port = link.sourcePort || 0
        outputs[port] = outputs[port] || []
        outputs[port].push(link.target.id)
      }
    })
    return outputs
  }

  function extractNodeConfig(node) {
    // Extract only serializable properties, avoiding circular references
    const config = {
      id: node.id,
      type: node.type,
      name: node.name,
      info: node.info,
      x: node.x,
      y: node.y,
      z: node.z,
      wires: node.wires || getNodeWiresFromLinks(node.id)
    }

    // Add type-specific properties
    const functionalKeys = [
      'func',
      'rules',
      'url',
      'method',
      'ret',
      'property',
      'payload',
      'topic',
      'to',
      'outputs',
      'split',
      'fixdmax',
      'complete',
      'finalize',
      'initialize',
      'payloadType',
      'repeat',
      'crontab',
      'once',
      'active',
      'tosidebar',
      'console',
      'tostatus'
    ]

    functionalKeys.forEach(key => {
      if (key in node && node[key] !== undefined) {
        config[key] = node[key]
      }
    })

    return config
  }

  function extractFunctionalProperties(node) {
    const functional = {}
    const keys = [
      'func',
      'rules',
      'url',
      'method',
      'ret',
      'property',
      'payload',
      'topic',
      'to',
      'outputs',
      'split',
      'fixdmax',
      'complete',
      'finalize',
      'initialize'
    ]

    keys.forEach(key => {
      if (key in node) {
        functional[key] = node[key]
      }
    })

    return functional
  }

  function functionalPropertiesChanged(node) {
    const current = extractFunctionalProperties(node)
    const previous = window.nodeFunctionalState[node.id]

    if (!previous) {
      return false
    }

    return JSON.stringify(current) !== JSON.stringify(previous)
  }

  function storeFunctionalState(node) {
    window.nodeFunctionalState[node.id] = extractFunctionalProperties(node)
  }

  async function with429Retry(nodeId, requestFn) {
    let attempt = 0

    while (attempt < 10) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return await requestFn()
      } catch (error) {
        if (error?.response?.status === 429) {
          attempt += 1
          const retryAfterHeader = error.response.headers?.['retry-after']
          const retryAfterBody = error.response.data?.retryAfter ?? error.response.data?.retry_after
          const retryAfterSeconds = Number(retryAfterHeader ?? retryAfterBody)
          const waitMs = (
            Number.isFinite(retryAfterSeconds)
              ? retryAfterSeconds * 1000
              : 1000
          ) + 1000
          const waitSeconds = Math.ceil(waitMs / 1000)

          setNodeSyncStatus(nodeId, 'waiting')
          RED.notify(`Rate limited. Retrying in ${waitSeconds}s...`, 'warning')

          // eslint-disable-next-line no-await-in-loop, no-promise-executor-return
          await new Promise(resolve => setTimeout(resolve, waitMs))

          setNodeSyncStatus(nodeId, true)
          // eslint-disable-next-line no-continue
          continue
        }

        throw error
      }
    }

    throw new Error('Maximum retry attempts reached due to rate limiting')
  }

  async function resyncNodeWithAI(node, direction = 'info-to-logic') {
    const httpClient = window.axios
    const currentConfig = extractNodeConfig(node)

    if (!httpClient) {
      throw new Error('Axios client not available in editor')
    }

    // Mark node as syncing (yellow dot)
    setNodeSyncStatus(node.id, true)

    try {
      if (direction === 'info-to-logic') {
        // Call AI to regenerate node logic based on new info
        const { data } = await with429Retry(node.id, () => httpClient.post(
          '/ai/resync-node',
          {
            nodeId: node.id,
            nodeType: node.type,
            nodeName: node.name,
            info: node.info,
            currentConfig
          },
          { headers: { 'Content-Type': 'application/json' } }
        ))

        if (data.success && data.updatedNode) {
          // Update node with AI-generated config
          Object.assign(node, data.updatedNode)

          // Update registry with new synced info
          window.semanticNodeRegistry[node.id] = {
            info: node.info,
            lastSynced: Date.now()
          }

          storeFunctionalState(node)

          // Force UI updates
          RED.nodes.dirty(true)
          node.dirty = true
          RED.view.redraw(true)

          // Update tooltip content
          updateNodeTooltip(node)
        } else {
          throw new Error(data.error || 'Failed to sync node with AI')
        }
      } else if (direction === 'logic-to-info') {
        // Call AI to generate semantic description from logic
        const { data } = await with429Retry(node.id, () => httpClient.post(
          '/ai/generate-description',
          {
            nodeId: node.id,
            nodeType: node.type,
            nodeName: node.name,
            currentConfig
          },
          { headers: { 'Content-Type': 'application/json' } }
        ))

        if (!data.success) {
          throw new Error(data.error || 'Failed to generate description')
        }

        if (!data.name || !data.description) {
          throw new Error(`AI response missing name or description. Got: ${JSON.stringify(data)}`)
        }

        // Update node name
        node.name = data.name

        // Update node info with AI-generated description
        node.info = data.description

        // Update registry
        window.semanticNodeRegistry[node.id] = {
          info: node.info,
          lastSynced: Date.now()
        }

        storeFunctionalState(node)

        // Force UI updates
        RED.nodes.dirty(true)
        node.dirty = true
        node.changed = true

        // Trigger Node-RED's internal update
        RED.events.emit('nodes:change', node)

        // Force canvas redraw
        RED.view.redraw(true)

        // Update tooltip content
        updateNodeTooltip(node)

        console.log('[node-tooltip] Description generated successfully:', node.id)
      }
    } catch (error) {
      console.error('[node-tooltip] Re-sync failed:', error)
      RED.notify('Failed to sync node with AI', 'error')
    } finally {
      // Remove syncing status (remove yellow dot)
      setNodeSyncStatus(node.id, false)
    }
  }

  function saveAndExitEditMode(content, rawInfo, node, instance) {
    const newText = content.textContent.trim()
    const displayText = newText ? stripMarkdown(newText).trim() : node.name || node.type || 'Node'

    if (newText !== rawInfo) {
      // Check if info changed BEFORE updating the node
      const registry = window.semanticNodeRegistry[node.id]
      const infoChanged = !registry || registry.info !== newText

      // Update the node
      node.info = newText
      node.changed = true
      RED.nodes.dirty(true)

      // Trigger node change events so Node-RED updates the node
      RED.events.emit('nodes:change', node)
      RED.nodes.node(node.id).info = newText

      // Force view update
      RED.view.redraw()

      // If info changed, trigger AI resync
      if (infoChanged) {
        resyncNodeWithAI(node, 'info-to-logic').catch(error => {
          RED.notify(`Failed to sync node: ${error.message}`, 'error')
        })
      }
    }

    exitEditMode(content, instance, node, displayText, true)
  }

  function registerNodeInRegistry(node) {
    // Always store functional state when we first see a node
    if (!window.nodeFunctionalState[node.id]) {
      storeFunctionalState(node)
    }

    // Register in semantic registry if node has info
    if (node.info && !window.semanticNodeRegistry[node.id]) {
      window.semanticNodeRegistry[node.id] = {
        info: node.info,
        lastSynced: Date.now()
      }
    }
  }

  function showEditOverlay(instance, content, rawInfo, node) {
    let overlay = document.getElementById('node-tooltip-overlay')

    if (!overlay) {
      overlay = document.createElement('div')
      overlay.id = 'node-tooltip-overlay'
      overlay.className = 'ui-widget-overlay ui-front node-tooltip-overlay'
      document.body.appendChild(overlay)
    }

    // Remove old click handler
    overlay.onclick = null

    // Click on overlay saves changes
    overlay.onclick = e => {
      e.preventDefault()
      e.stopPropagation()
      console.log('[node-tooltip] Overlay clicked - saving changes')
      saveAndExitEditMode(content, rawInfo, node, instance)
    }

    overlay.style.display = 'block'
  }

  function addCloseButton(content, instance, node, displayText) {
    const existingBtn = content.parentElement?.querySelector('.tooltip-close-btn')
    if (existingBtn) {
      existingBtn.remove()
    }

    const closeBtn = document.createElement('button')
    closeBtn.className = 'tooltip-close-btn'
    closeBtn.innerHTML = '×'
    closeBtn.title = 'Discard changes (Esc)'

    closeBtn.onclick = e => {
      e.preventDefault()
      e.stopPropagation()
      console.log('[node-tooltip] Close button clicked - discarding changes')
      content.textContent = displayText
      exitEditMode(content, instance, node, displayText, false)
    }

    content.parentElement.style.position = 'relative'
    content.parentElement.appendChild(closeBtn)
  }

  function enterEditMode(instance, content, rawInfo, node, displayText) {
    console.log('[node-tooltip] Entering edit mode for node:', node.id)
    showEditOverlay(instance, content, rawInfo, node, displayText)

    content.contentEditable = 'true'
    content.style.padding = '12px 40px 12px 16px'
    content.textContent = rawInfo || displayText

    instance.popper.classList.add('red-ui-popover')

    // Keep tooltip permanently visible and interactive
    instance.setProps({
      trigger: 'manual',
      hideOnClick: false,
      interactive: true
    })

    // Force show and keep visible
    instance.show()

    // Override Tippy's visibility controls
    setTimeout(() => {
      instance.popper.style.pointerEvents = 'auto'
      instance.popper.style.zIndex = '10002'

      const box = instance.popper.querySelector('.tippy-box')
      if (box) {
        box.setAttribute('data-state', 'visible')
      }

      const contentEl = instance.popper.querySelector('.tippy-content')
      if (contentEl) {
        contentEl.setAttribute('data-state', 'visible')
      }
    }, 10)

    addCloseButton(content, instance, node, displayText, rawInfo)

    // Focus and select all text
    setTimeout(() => {
      const range = document.createRange()
      const sel = window.getSelection()
      range.selectNodeContents(content)
      range.collapse(false)
      sel.removeAllRanges()
      sel.addRange(range)
      content.focus()
      console.log('[node-tooltip] Content editable:', content.contentEditable)
    }, 50)

    content.onkeydown = function (e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        console.log('[node-tooltip] Escape pressed - discarding changes')
        content.textContent = displayText
        exitEditMode(content, instance, node, displayText, false)
      }
      if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault()
        saveAndExitEditMode(content, rawInfo, node, instance)
      }
    }
  }

  function setupTooltipClickHandler(instance, displayText, rawInfo, node) {
    const content = instance.popper.querySelector('.node-tooltip-content')

    if (!content) {
      console.log('[node-tooltip] Warning: Could not find tooltip content')
      return
    }

    // Remove old click handler if exists
    content.onclick = null

    content.onclick = function (e) {
      e.stopPropagation()
      console.log('[node-tooltip] Tooltip clicked, entering edit mode')
      if (
        content.contentEditable === 'false'
        || !content.contentEditable
        || content.contentEditable === 'inherit'
      ) {
        enterEditMode(instance, content, rawInfo, node, displayText)
      }
    }
  }

  function updateNodeTooltip(node) {
    let displayText = ''
    let rawInfo = ''

    if (!node || !node.id) {
      return
    }

    const nodeElement = document.getElementById(node.id)

    if (!nodeElement) {
      setTimeout(() => updateNodeTooltip(node), 100)
      return
    }

    // Always register the node (to track functional state)
    registerNodeInRegistry(node)

    if (node.info && node.info.trim()) {
      rawInfo = node.info
      displayText = stripMarkdown(node.info).trim()
    }

    if (!displayText && node.name) {
      displayText = node.name
    }

    if (!displayText) {
      displayText = node.type || 'Node'
    }

    if (displayText.length > 500) {
      displayText = `${displayText.substring(0, 497)}...`
    }

    nodeElement.removeAttribute('title')
    nodeElement.removeAttribute('alt')

    const existingInstance = tippyInstances.get(node.id)
    if (existingInstance) {
      existingInstance.destroy()
    }

    const instance = tippy(nodeElement, {
      content: createTooltipContent(displayText, rawInfo, node),
      allowHTML: true,
      interactive: true,
      trigger: 'mouseenter',
      placement: 'right',
      theme: 'dark',
      maxWidth: 450,
      appendTo: document.body,
      zIndex: 10001,
      onShow(tippyInstance) {
        setupTooltipClickHandler(tippyInstance, displayText, rawInfo, node)
      }
    })

    tippyInstances.set(node.id, instance)
  }

  function observeWorkspace() {
    const workspace = document.querySelector('#red-ui-workspace-chart')

    if (!workspace) {
      console.log('[node-tooltip] Workspace not found, retrying...')
      setTimeout(observeWorkspace, 1000)
      return
    }

    const observer = new MutationObserver(mutations => {
      mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
          if (node.classList && node.classList.contains('red-ui-flow-node')) {
            const nodeId = node.id
            const nodeData = RED.nodes.node(nodeId)

            if (nodeData) {
              setTimeout(() => updateNodeTooltip(nodeData), 100)
            }
          }
        })
      })
    })

    observer.observe(workspace, {
      childList: true,
      subtree: true
    })

    console.log('[node-tooltip] Workspace observer initialized')
  }

  function updateAllTooltips() {
    RED.nodes.eachNode(node => {
      updateNodeTooltip(node)
    })
  }

  function initializeTooltips() {
    console.log('[node-tooltip] Initializing tooltips for all nodes')
    updateAllTooltips()
    observeWorkspace()
  }

  RED.plugins.registerPlugin('node-tooltip', {
    type: 'node-red-semantic-flow-language-tooltip',
    onadd() {
      console.log('[node-tooltip] Plugin loaded')

      // Wait for Tippy.js to be loaded by plugin.html
      const waitForTippy = () => {
        if (typeof tippy === 'undefined') {
          setTimeout(waitForTippy, 100)
          return
        }

        // Tippy.js is ready, initialize
        RED.events.on('editor:open', () => {
          initializeTooltips()
        })

        RED.events.on('nodes:change', node => {
          if (node && node.id) {
            // Check if functional properties changed (logic edited)
            if (functionalPropertiesChanged(node)) {
              console.log(
                '[node-tooltip] Functional properties changed, generating description for:',
                node.id
              )
              resyncNodeWithAI(node, 'logic-to-info')
            }

            updateNodeTooltip(node)
          }
        })

        RED.events.on('workspace:change', () => {
          updateAllTooltips()
        })

        setTimeout(initializeTooltips, 1000)
      }

      waitForTippy()
    }
  })
}())
