/*
  Node-RED Editor Plugin: AI Prompt Sidebar
  Adds a sidebar panel for AI prompt input
  Part of Semantic Flow Language - Phase 1
*/

(function () {
  let sidebarInitialized = false

  function handlePromptSubmit() {
    const promptArea = $('#ai-prompt-input')
    const responseArea = $('#ai-prompt-response')
    const submitBtn = $('.red-ui-button.send-prompt')
    const prompt = promptArea.val().trim()

    if (!prompt) {
      RED.notify('Please enter a flow description', 'warning')
      return
    }

    console.log('[ai-flow-builder] Building flow from prompt:', prompt)

    // Show loading state
    submitBtn.prop('disabled', true)
    submitBtn.addClass('sent-prompt')
    responseArea.text('Building your flow...').show()

    // Get current workspace context (only nodes from current tab)
    const currentTab = RED.workspaces.active()
    const currentFlow = RED.nodes.createCompleteNodeSet()
    const currentTabNodes = currentFlow.filter(
      n => n.type !== 'tab' && n.type !== 'subflow' && n.z === currentTab
    )
    const context = {
      nodes: currentTabNodes,
      hasNodes: currentTabNodes.length > 0
    }

    // Detect intent from prompt (create/build = new tab, add/update = existing tab)
    const createIntent = /\b(create|build|make|generate|new)\b/i.test(prompt)
    const updateIntent = /\b(add|update|modify|change|append|insert)\b/i.test(prompt)
    const shouldCreateNewTab = createIntent && !updateIntent
    const httpClient = window.axios

    if (!httpClient) {
      const errorMsg = 'Axios client not available. Please ensure it is loaded in the editor.'

      responseArea.text(errorMsg).show()
      RED.notify('Failed to build flow', 'error')
      console.error('[ai-flow-builder] Error:', errorMsg)

      return
    }

    // Call AI service
    httpClient
      .post(
        '/ai/build-flow',
        {
          prompt,
          context: context.hasNodes && !shouldCreateNewTab ? context : undefined
        },
        { headers: { 'Content-Type': 'application/json' } }
      )
      .then(({ data }) => {
        if (!data.success) {
          throw new Error(data.error || 'Failed to generate flow')
        }

        // Import the AI-generated flow
        if (data.flow && data.flow.length > 0) {
          let targetTab = RED.workspaces.active()
          const newTabId = RED.nodes.id()

          // If intent is to create/build, make a new tab
          if (shouldCreateNewTab) {
            // Set target to new tab BEFORE setting z properties
            targetTab = newTabId

            const tabNode = {
              type: 'tab',
              id: newTabId,
              label: data.flowName || 'AI Flow',
              disabled: false,
              info: `# AI Generated Flow\n\nPrompt: ${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}`
            }

            // Set z property on all nodes to new tab
            data.flow.forEach(node => {
              node.z = targetTab
            })

            // Import tab + nodes together
            RED.nodes.import([tabNode, ...data.flow])
            RED.workspaces.show(newTabId)
            RED.nodes.eachNode(node => {
              if (node.z === targetTab) {
                node.changed = true
                node.dirty = true
                RED.events.emit('nodes:change', node)
              }
            })
            RED.view.redraw(true)
            // Mark flow as modified
            RED.nodes.dirty(true)
          } else {
            // Smart merge: Update existing nodes, add new ones, remove orphaned ones
            // Build map of existing nodes in current tab
            const existingNodes = new Map()
            const newNodesMap = new Map()
            const nodesToUpdate = []
            const nodesToAdd = []

            RED.nodes.eachNode(node => {
              if (node.z === targetTab) {
                existingNodes.set(node.id, node)
              }
            })

            // Build map of new nodes from AI
            data.flow.forEach(node => {
              node.z = targetTab
              newNodesMap.set(node.id, node)
            })

            // Separate nodes into update vs add
            data.flow.forEach(newNode => {
              if (existingNodes.has(newNode.id)) {
                nodesToUpdate.push(newNode)
              } else {
                nodesToAdd.push(newNode)
              }
            })

            // FIRST: Add new nodes using import (so they exist for wire updates)
            if (nodesToAdd.length > 0) {
              RED.nodes.import(nodesToAdd)

              // Fix wires for newly added nodes
              nodesToAdd.forEach(newNode => {
                const node = RED.nodes.node(newNode.id)

                if (node && Array.isArray(newNode.wires)) {
                  // Remove any auto-created links from import
                  const linksToRemove = []

                  RED.nodes.eachLink(link => {
                    if (link.source && link.source.id === node.id) {
                      linksToRemove.push(link)
                    }
                  })

                  linksToRemove.forEach(link => RED.nodes.removeLink(link))
                  // Set wires and rebuild links
                  node.wires = newNode.wires.map(wireSet => [...wireSet])

                  newNode.wires.forEach((wireSet, portIndex) => {
                    wireSet.forEach(targetId => {
                      const targetNode = RED.nodes.node(targetId)
                      if (targetNode) {
                        RED.nodes.addLink({
                          source: node,
                          sourcePort: portIndex,
                          target: targetNode
                        })
                      }
                    })
                  })

                  node.changed = true
                  node.dirty = true
                  RED.events.emit('nodes:change', node)
                }
              })
            }

            // SECOND: Update existing nodes (now wires can reference new nodes)
            nodesToUpdate.forEach(newNode => {
              const existingNode = existingNodes.get(newNode.id)
              // Update all properties including position and wires
              const skipKeys = new Set(['id', 'type', 'z', 'x', 'y', 'wires'])

              Object.keys(newNode).forEach(key => {
                if (!skipKeys.has(key)) {
                  existingNode[key] = newNode[key]
                }
              })

              if (newNode.x !== undefined || newNode.y !== undefined) {
                existingNode.x = newNode.x ?? existingNode.x
                existingNode.y = newNode.y ?? existingNode.y
              }

              if (Array.isArray(newNode.wires)) {
                const linksToRemove = []

                RED.nodes.eachLink(link => {
                  if (link.source && link.source.id === existingNode.id) {
                    linksToRemove.push(link)
                  }
                })

                linksToRemove.forEach(link => RED.nodes.removeLink(link))
                existingNode.wires = newNode.wires.map(wireSet => [...wireSet])

                newNode.wires.forEach((wireSet, portIndex) => {
                  wireSet.forEach(targetId => {
                    const targetNode = RED.nodes.node(targetId)

                    if (targetNode) {
                      RED.nodes.addLink({
                        source: existingNode,
                        sourcePort: portIndex,
                        target: targetNode
                      })
                    }
                  })
                })
              }

              // Trigger change event for UI update
              RED.events.emit('nodes:change', existingNode)
              // Force node position update in UI
              existingNode.dirty = true
            })

            // THIRD: Remove nodes that are no longer in the flow
            existingNodes.forEach((node, nodeId) => {
              if (!newNodesMap.has(nodeId)) {
                console.log('[ai-flow-builder] Removing orphaned node:', nodeId)
                RED.nodes.remove(nodeId)
              }
            })

            // Mark as dirty
            RED.nodes.dirty(true)

            // Force complete redraw with force=true
            setTimeout(() => {
              RED.view.redraw(true)
            }, 100)
          }

          let successMsg = `Flow ${shouldCreateNewTab ? 'created' : 'updated'} successfully! Generated ${data.flow.length} nodes`

          if (data.metadata) {
            if (data.metadata.usage) {
              successMsg += `\nTokens used: ${data.metadata.usage.total_tokens}`
            }

            if (data.metadata.citations && data.metadata.citations.length > 0) {
              successMsg += `\nUsed ${data.metadata.citations.length} documentation sources`
            }
          }

          responseArea.text(successMsg).show()
          RED.notify('Flow built from AI prompt', 'success')
          // Mark flow as modified
          RED.nodes.dirty(true)
        } else {
          responseArea.text('AI returned empty flow. Try rephrasing your prompt.')
          RED.notify('No nodes generated', 'warning')
        }
      })
      .catch(err => {
        const errorDetail = err.response?.data?.error
        const statusText = err.response
          ? `HTTP ${err.response.status}: ${err.response.statusText || 'Request failed'}`
          : err.message
        const errorMsg = `Error: ${errorDetail || statusText}\n\nPlease check:\n- AI connector is configured\n- API keys are valid\n- Network connection is stable`

        responseArea.text(errorMsg)
        RED.notify('Failed to build flow', 'error')
        console.error('[ai-flow-builder] Error:', err)
      })
      .finally(() => {
        const hasContent = promptArea.val().trim().length > 0
        submitBtn.prop('disabled', !hasContent)
        submitBtn.removeClass('sent-prompt')
      })
  }

  function initializeSidebar() {
    if (sidebarInitialized) {
      return
    }

    console.log('[ai-prompt-sidebar] Initializing sidebar')

    // Create the sidebar content container
    const container = $('<div>', {
      id: 'ai-prompt-panel',
      class: 'ai-prompt-container'
    })

    // Add description/help text
    const helpText = $('<div>', {
      class: 'ai-prompt-help'
    }).html(`
      <strong>Create or modify your flow:</strong><br>
      • Describe a complete flow to build<br>
      • Request modifications to existing flows<br>
      • Node details can be edited via tooltips
    `)

    // Add prompt textarea with flow-focused placeholder
    const promptArea = $('<textarea>', {
      id: 'ai-prompt-input',
      class: 'ai-prompt-textarea',
      placeholder:
        'Example:\n\n"Create an app that pulls all todays tickets from Zendesk everyday at 7am and sends a report to test@test.com showing how many tickets each agent closed"\n\nor\n\n"Add after sending email create a Zendesk ticket with that report"'
    })

    // Add button container
    const buttonContainer = $('<div>', {
      class: 'ai-prompt-buttons'
    })

    // Add response area
    const responseArea = $('<div>', {
      id: 'ai-prompt-response',
      class: 'ai-prompt-response'
    })

    // Add "Send Prompt" button
    const submitBtn = $('<button>', {
      class: 'red-ui-button send-prompt',
      text: 'Build Flow',
      disabled: true
    }).on('click', () => {
      handlePromptSubmit()
    })

    // Enable/disable button based on textarea content
    promptArea.on('input', () => {
      const hasContent = promptArea.val().trim().length > 0

      submitBtn.prop('disabled', !hasContent)
    })

    // Add "Clear" button
    const clearBtn = $('<button>', {
      class: 'red-ui-button',
      text: 'Clear'
    }).on('click', () => {
      promptArea.val('')
      responseArea.hide()
      submitBtn.prop('disabled', true)
    })

    // Assemble the UI
    buttonContainer.append(clearBtn).append(submitBtn)
    container.append(helpText).append(promptArea).append(responseArea).append(buttonContainer)

    // Add the sidebar tab as the first tab, open by default, and non-closeable
    RED.sidebar.addTab({
      id: 'ai-flow-builder',
      label: 'AI Builder',
      name: 'AI Flow Builder',
      content: container,
      closeable: false, // Make it sticky (non-closeable)
      enableOnEdit: true,
      iconClass: 'fa fa-magic',
      order: -1 // Make it the absolute first tab (farthest left)
    })

    console.log('[ai-prompt-sidebar] Sidebar tab added')

    // Function to show and configure the sidebar
    const configureSidebar = () => {
      console.log('[ai-prompt-sidebar] Configuring sidebar')
      const lastTab = localStorage.getItem('red-ui-last-sidebar-tab')

      if (!lastTab || lastTab === 'ai-flow-builder') {
        RED.sidebar.show('ai-flow-builder')
      }

      // Reorder the button to be first (farthest left)
      const button = $('.red-ui-tab-link-buttons')
      const aiButton = $('#red-ui-tab-ai-flow-builder-link-button')
      // We want second to last visible button
      const secondLastButton = button.children(':not([style*="display: none"])').eq(-2)

      if (button.length && aiButton.length) {
        // Move the AI button to the beginning (before all other buttons)
        button.prepend(aiButton)
        secondLastButton.css('display', 'none')
        aiButton.css('display', '')
      }

      // Track tab changes to persist the selection (only add once)
      if (!$('.red-ui-tab-link-button').data('ai-sidebar-tracked')) {
        $('.red-ui-tab-link-button').on('click', function handleTabClick() {
          const tabId = $(this).attr('href')?.substring(1)

          if (tabId) {
            localStorage.setItem('red-ui-last-sidebar-tab', tabId)
            console.log('[ai-prompt-sidebar] Saved last tab:', tabId)
          }
        })
        $('.red-ui-tab-link-button').data('ai-sidebar-tracked', true)
      }
    }

    // Poll until sidebar buttons exist OR flows are loaded, then configure
    const checkInterval = setInterval(() => {
      const button = $('.red-ui-tab-link-buttons')
      if (button.length > 0) {
        clearInterval(checkInterval)
        configureSidebar()
      }
    }, 100)

    // Also listen to flows:loaded as a secondary trigger
    RED.events.on('flows:loaded', () => {
      clearInterval(checkInterval)
      configureSidebar()
    })

    sidebarInitialized = true
    console.log('[ai-prompt-sidebar] Sidebar initialized')
  }

  RED.plugins.registerPlugin('ai-prompt-sidebar', {
    type: 'node-red-semantic-flow-language-ai-sidebar',
    onadd() {
      console.log('[ai-prompt-sidebar] Plugin loaded')

      // Wait for RED to be fully initialized
      RED.events.on('runtime-state', state => {
        if (state === 'start') {
          initializeSidebar()
        }
      })

      // Fallback initialization
      setTimeout(initializeSidebar, 1000)
    }
  })
}())
