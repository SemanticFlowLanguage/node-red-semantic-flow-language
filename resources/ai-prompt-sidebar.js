/*
  Node-RED Editor Plugin: AI Prompt Sidebar
  Adds a sidebar panel for AI prompt input
  Part of Semantic Flow Language - Phase 1
*/

(function () {
  let sidebarInitialized = false
  const autoVerifyState = {
    autoVerifyDefault: true,
    maxAttempts: 3,
    maxRestarts: 3,
    timeoutMs: 30000,
    canAutoDeploy: false,
    loaded: false
  }

  const TERMINAL_FAILURE_MSG = "Couldn't resolve — try rephrasing prompt and running again. If that also fails, escalate to dev."

  const adminPath = path => {
    const adminRoot = (RED?.settings?.httpAdminRoot || '').replace(/\/$/, '')

    return adminRoot ? `${adminRoot}${path}` : path
  }

  // Lightweight axios-shaped wrapper over jQuery's $.ajax (which Node-RED loads).
  // Resolves with { data } and rejects with an error carrying a `.response` field
  // shaped like axios so existing handlers keep working.
  const apiRequest = (method, path, body, opts = {}) => {
    const config = {
      url: adminPath(path),
      method,
      dataType: 'json'
    }

    if (body !== undefined) {
      config.contentType = 'application/json'
      config.data = JSON.stringify(body)
    }

    if (opts.timeout) {
      config.timeout = opts.timeout
    }

    return new Promise((resolve, reject) => {
      $.ajax(config)
        .done(data => resolve({ data }))
        .fail((xhr, status, errText) => {
          const message = errText || status || 'request failed'
          const wrapped = new Error(message)

          if (xhr) {
            wrapped.response = {
              status: xhr.status,
              statusText: xhr.statusText || '',
              data: xhr.responseJSON || xhr.responseText || ''
            }
          }

          reject(wrapped)
        })
    })
  }

  const fetchAutoVerifySettings = async () => {
    try {
      const { data } = await apiRequest('GET', '/ai/auto-verify/settings')

      if (data && data.success && data.settings) {
        Object.assign(autoVerifyState, data.settings, { loaded: true })

        const toggle = $('#ai-auto-verify-toggle')
        const row = $('.ai-auto-verify-row')

        if (autoVerifyState.canAutoDeploy) {
          row.show()

          if (toggle.length && !toggle.data('user-changed')) {
            toggle.prop('checked', !!autoVerifyState.autoVerifyDefault)
          }
        } else {
          // NODE_ENV is blank or "production" — hide the switch and force it
          // off so handlePromptSubmit doesn't run the verify loop. Also clear
          // autoVerifyDefault so the fallback (no toggle present) stays off.
          row.hide()
          toggle.prop('checked', false)
          autoVerifyState.autoVerifyDefault = false
        }
      }
    } catch (err) {
      console.warn('[ai-flow-builder] Failed to load auto-verify settings', err)
    }
  }

  // Fire-and-forget audit emission. The server is the source of truth for the
  // destination (red.log / URL / file / silent) — this just POSTs the event
  // and ignores both the response and any error. Never blocks the verify loop.
  const emitAudit = event => {
    try {
      apiRequest('POST', '/ai/audit/event', event).catch(() => { /* drop */ })
    } catch (err) {
      // ignore — audit must never break the loop
    }
  }

  // Audit-stable signature: strip Node-RED ids (16-hex), UUIDs, ISO timestamps,
  // and bare numbers so equivalent errors across runs hash identically. Used
  // for the `error_signature` field on auto_verify_attempt events.
  const auditErrorSignature = (errors, kind) => {
    const normalized = errors
      .map(s => String(s)
        .replace(/\b[0-9a-f]{16}\b/gi, '<id>')
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
        .replace(/\b\d+\b/g, '<n>'))
      .sort()

    return `${kind}|${normalized.join('|')}`.substring(0, 512)
  }

  // Syntax check delegates to Node-RED's own per-node validator — the same one
  // that puts the red error triangle on invalid nodes in the editor. It already
  // covers required fields, typedInput types, JSONata expressions, and any
  // custom defaults.<field>.validate function the node ships. We add structural
  // checks for things Node-RED silently drops on import: unknown node types and
  // dangling wires.
  const runSyntaxCheck = (targetTab, currFlow) => {
    const errors = []
    const knownIds = new Set()
    const safeFlow = Array.isArray(currFlow) ? currFlow : []

    RED.nodes.eachNode(n => knownIds.add(n.id))

    if (typeof RED?.nodes?.eachConfig === 'function') {
      RED.nodes.eachConfig(n => knownIds.add(n.id))
    }

    safeFlow.forEach(n => {
      if (n && n.id) {
        knownIds.add(n.id)
      }
    })

    safeFlow.forEach(node => {
      if (!node || !node.type) {
        return
      }

      if (node.type === 'tab' || node.type === 'subflow') {
        return
      }

      const def = typeof RED?.nodes?.getType === 'function' ? RED.nodes.getType(node.type) : null

      if (!def) {
        errors.push(`Node "${node.id}" has unknown type "${node.type}"`)

        return
      }

      if (Array.isArray(node.wires)) {
        node.wires.forEach((wireSet, port) => {
          if (!Array.isArray(wireSet)) {
            errors.push(`Node "${node.id}" wires[${port}] is not an array`)

            return
          }

          wireSet.forEach(targetId => {
            if (!knownIds.has(targetId)) {
              errors.push(`Node "${node.id}" wires to missing node "${targetId}" (port ${port})`)
            }
          })
        })
      }
    })

    // Ask Node-RED to validate every node on the target tab. validateNode mutates
    // node.valid + node.validationErrors so we can read the result right after.
    const validateOne = node => {
      const fns = [RED?.editor?.validateNode, RED?.nodes?.validateNode]

      fns.forEach(fn => {
        if (typeof fn === 'function') {
          try { fn(node) } catch (e) {
            // best-effort — fall through to inspecting node.valid
          }
        }
      })
    }

    RED.nodes.eachNode(node => {
      if (node.z !== targetTab) {
        return
      }

      validateOne(node)

      if (node.valid === false) {
        const props = Array.isArray(node.validationErrors) ? node.validationErrors : []
        const detail = props.length ? `invalid field(s): ${props.join(', ')}` : 'configuration invalid'

        errors.push(`Node "${node.id}" (${node.type}) ${detail}`)
      }
    })

    return errors
  }

  const computeFlowDiff = (prev, curr) => {
    const prevMap = new Map((prev || []).map(n => [n.id, n]))
    const currMap = new Map((curr || []).map(n => [n.id, n]))
    const added = []
    const removed = []
    const modified = []

    currMap.forEach((node, id) => {
      if (!prevMap.has(id)) {
        added.push({ id, type: node.type, name: node.name || '' })
      } else {
        const before = prevMap.get(id)
        const changedKeys = []
        const allKeys = new Set([...Object.keys(before || {}), ...Object.keys(node || {})])

        allKeys.forEach(k => {
          if (k === 'x' || k === 'y' || k === 'z') {
            return
          }

          if (JSON.stringify(before[k]) !== JSON.stringify(node[k])) {
            changedKeys.push(k)
          }
        })

        if (changedKeys.length) {
          modified.push({ id, type: node.type, changedFields: changedKeys })
        }
      }
    })

    prevMap.forEach((node, id) => {
      if (!currMap.has(id)) {
        removed.push({ id, type: node.type, name: node.name || '' })
      }
    })

    return { added, removed, modified }
  }

  const summarizeDiff = diff => {
    const parts = []

    if (diff.added.length) {
      parts.push(`+${diff.added.length} node(s): ${diff.added.map(n => `${n.id}(${n.type})`).join(', ')}`)
    }

    if (diff.removed.length) {
      parts.push(`-${diff.removed.length} node(s): ${diff.removed.map(n => `${n.id}(${n.type})`).join(', ')}`)
    }

    if (diff.modified.length) {
      parts.push(`~${diff.modified.length} node(s): ${diff.modified.map(n => `${n.id}[${n.changedFields.join(',')}]`).join(', ')}`)
    }

    return parts.length ? parts.join('; ') : 'no changes'
  }

  const summarizeErrors = errors => {
    if (!errors.length) {
      return ''
    }

    const first = errors[0]
    const rest = errors.length > 1 ? ` (+${errors.length - 1} more)` : ''

    return `${first}${rest}`
  }

  // Stable signature: sorted, joined error strings. Used for early-stop on convergence.
  const errorSignature = errors => ([...errors].sort().join('|').substring(0, 512))

  const observeRuntimeErrors = (timeoutMs, targetTab) => new Promise(resolve => {
    const collected = []
    const debugHandler = data => {
      if (!data) {
        return
      }

      // Node-RED debug stream sends entries with level 20 = error, 30 = warn.
      const level = Number(data.level)

      if (level === 20 && (!targetTab || !data.z || data.z === targetTab)) {
        collected.push({
          id: data.id || '',
          source: (data.source && data.source.name) || data.name || '',
          msg: typeof data.msg === 'string' ? data.msg : JSON.stringify(data.msg),
          format: data.format || ''
        })
      }
    }
    const statusHandler = data => {
      if (data && data.status && data.status.fill === 'red' && (!targetTab || data.z === targetTab)) {
        collected.push({
          id: data.id || '',
          source: 'status',
          msg: data.status.text || 'node reported error status',
          format: ''
        })
      }
    }
    const teardown = () => {
      if (RED?.comms?.unsubscribe) {
        try { RED.comms.unsubscribe('debug', debugHandler) } catch {
          // best-effort
        }

        try { RED.comms.unsubscribe('status/#', statusHandler) } catch {
          // best-effort
        }
      }
    }

    if (RED?.comms?.subscribe) {
      RED.comms.subscribe('debug', debugHandler)
      RED.comms.subscribe('status/#', statusHandler)
    }

    setTimeout(() => {
      teardown()
      resolve(collected)
    }, timeoutMs)
  })

  const triggerDeploy = async () => {
    if (RED?.actions?.invoke) {
      try {
        RED.actions.invoke('core:deploy-flows')

        return true
      } catch (err) {
        console.warn('[ai-flow-builder] core:deploy-flows action failed', err)
      }
    }

    if (RED?.deploy?.deploy) {
      try {
        RED.deploy.deploy()

        return true
      } catch (err) {
        console.warn('[ai-flow-builder] RED.deploy.deploy failed', err)
      }
    }

    return false
  }

  // Build the verify panel exactly once. Preserves whatever text already lives
  // in responseArea (e.g. "Building your flow...") and appends a list element
  // that the loop will append entries into. Nothing is ever cleared mid-run.
  const initVerifyPanel = responseArea => {
    responseArea.show()

    const listEl = $('<div>', { class: 'ai-verify-attempts' })

    responseArea.append(listEl)

    return { listEl }
  }

  // Paint a single attempt entry in place. First paint creates the four child
  // divs (num/error/change/outcome) in a fixed order; subsequent paints only
  // update text content where it actually changed and toggle visibility on the
  // optional rows. No .empty() — earlier siblings are never torn down.
  const paintAttempt = (el, entry) => {
    el.attr('class', 'ai-verify-attempt')
    el.attr('data-outcome', entry.outcome)
    el.attr('data-phase', entry.phase || '')

    const ensure = cls => {
      let child = el.children(`.${cls}`).first()

      if (!child.length) {
        child = $('<div>', { class: cls })
        el.append(child)
      }

      return child
    }

    const numEl = ensure('ai-verify-attempt-num')
    const errEl = ensure('ai-verify-error')
    const changeEl = ensure('ai-verify-change')
    const outcomeEl = ensure('ai-verify-outcome')

    const phaseLabels = { syntax: 'Syntax', runtime: 'Runtime' }
    const phaseLabel = phaseLabels[entry.phase] || ''
    const headerText = phaseLabel
      ? `Attempt ${entry.number} · ${phaseLabel}`
      : `Attempt ${entry.number}`

    if (numEl.text() !== headerText) {
      numEl.text(headerText)
    }

    const errText = entry.errorSummary ? `Error: ${entry.errorSummary}` : ''

    if (errEl.text() !== errText) {
      errEl.text(errText)
    }

    errEl.css('display', entry.errorSummary ? '' : 'none')

    const changeText = entry.changeSummary ? `Change: ${entry.changeSummary}` : ''

    if (changeEl.text() !== changeText) {
      changeEl.text(changeText)
    }

    changeEl.css('display', entry.changeSummary ? '' : 'none')

    outcomeEl.attr('class', `ai-verify-outcome ai-verify-outcome-${entry.outcome}`)

    const outcomeText = `Outcome: ${entry.outcomeText}`

    if (outcomeEl.text() !== outcomeText) {
      outcomeEl.text(outcomeText)
    }
  }

  const paintEntry = (el, entry) => {
    const kind = entry.kind || 'attempt'

    el.attr('data-kind', kind)

    if (kind === 'restart') {
      el.attr('class', 'ai-verify-restart')
      const text = `— Restart ${entry.restartNumber} of ${entry.totalRestarts}: regenerating from scratch —`

      if (el.text() !== text) {
        el.text(text)
      }

      return
    }

    if (kind === 'running') {
      el.attr('class', 'ai-verify-running')

      if (el.text() !== entry.text) {
        el.text(entry.text)
      }

      return
    }

    if (kind === 'terminal') {
      el.attr('class', `ai-verify-terminal ai-verify-terminal-${entry.outcome || 'unresolved'}`)

      if (el.text() !== entry.text) {
        el.text(entry.text)
      }

      return
    }

    paintAttempt(el, entry)
  }

  // Append-mostly render. New entries get appended; only the LAST entry is
  // ever re-painted (it's the one being actively mutated through its phases).
  // Earlier entries are frozen — their DOM is never touched again after the
  // next sibling exists.
  const renderCorrectionLog = (panel, entries) => {
    const domCount = panel.listEl.children().length

    // Append DOM for any new entries that don't yet have one.
    for (let i = domCount; i < entries.length; i += 1) {
      panel.listEl.append($('<div>'))
    }

    // Paint any newly-appended entries except the last one. Normally render()
    // is called after every push so this loop is empty, but it catches up if
    // multiple entries were pushed without an intervening render.
    for (let i = domCount; i < entries.length - 1; i += 1) {
      paintEntry(panel.listEl.children().eq(i), entries[i])
    }

    // Always paint the last entry — it's the one being updated.
    if (entries.length > 0) {
      const lastIdx = entries.length - 1
      paintEntry(panel.listEl.children().eq(lastIdx), entries[lastIdx])
    }
  }

  const isConfigType = type => {
    const def = typeof RED?.nodes?.getType === 'function' ? RED.nodes.getType(type) : null

    return !!(def && def.category === 'config')
  }

  const rewireNode = (node, newWires) => {
    if (!Array.isArray(newWires)) {
      return
    }

    const linksToRemove = []

    RED.nodes.eachLink(link => {
      if (link.source && link.source.id === node.id) {
        linksToRemove.push(link)
      }
    })
    linksToRemove.forEach(link => RED.nodes.removeLink(link))
    node.wires = newWires.map(w => [...w])

    newWires.forEach((wireSet, port) => {
      wireSet.forEach(targetId => {
        const target = RED.nodes.node(targetId)

        if (target) {
          RED.nodes.addLink({ source: node, sourcePort: port, target })
        }
      })
    })
  }

  // Idempotent merge for use across the original generation AND correction iterations.
  // - Flow nodes on targetTab: existing get updated in place, missing get imported,
  //   orphaned get removed.
  // - Config nodes (no z): existing get updated in place, missing get imported.
  // This avoids "Imported duplicate nodes" when the AI returns the same ids again.
  const mergeFlowIntoTab = (targetTab, newFlow) => {
    const flowNodes = []
    const configNodes = []

    newFlow.forEach(n => {
      if (!n || !n.type) {
        return
      }

      if (n.type === 'tab' || n.type === 'subflow') {
        return
      }

      if (isConfigType(n.type)) {
        configNodes.push(n)
      } else {
        n.z = targetTab
        flowNodes.push(n)
      }
    })

    const existingOnTab = new Map()

    RED.nodes.eachNode(node => {
      if (node.z === targetTab) {
        existingOnTab.set(node.id, node)
      }
    })

    // Build a remap for any ids the AI returned that collide with nodes living on
    // OTHER tabs or as global config nodes. Without this, RED.nodes.import throws
    // "Imported duplicate nodes" when the AI happens to produce an id already in
    // use elsewhere in the user's project. Existing-on-this-tab ids are intentionally
    // left alone — those are updated in place.
    const idRemap = new Map()
    const newId = () => (typeof RED?.nodes?.id === 'function' ? RED.nodes.id() : `r${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`)
    const considerRemap = node => {
      if (!node || !node.id) {
        return
      }

      if (existingOnTab.has(node.id)) {
        return
      }

      if (typeof RED?.nodes?.node === 'function' && RED.nodes.node(node.id)) {
        idRemap.set(node.id, newId())
      }
    }

    flowNodes.forEach(considerRemap)
    configNodes.forEach(considerRemap)

    if (idRemap.size > 0) {
      const rewriteRefs = node => {
        if (idRemap.has(node.id)) {
          node.id = idRemap.get(node.id)
        }

        if (Array.isArray(node.wires)) {
          node.wires = node.wires.map(set => set.map(t => idRemap.get(t) || t))
        }

        const def = typeof RED?.nodes?.getType === 'function' ? RED.nodes.getType(node.type) : null
        const defaults = (def && def.defaults) || {}

        Object.keys(defaults).forEach(field => {
          const fieldDef = defaults[field] || {}

          if (fieldDef.type && typeof fieldDef.type === 'string' && idRemap.has(node[field])) {
            node[field] = idRemap.get(node[field])
          }
        })
      }

      flowNodes.forEach(rewriteRefs)
      configNodes.forEach(rewriteRefs)
      console.warn(`[ai-flow-builder] remapped ${idRemap.size} colliding node id(s)`)
    }

    const newFlowIds = new Set(flowNodes.map(n => n.id))

    // 1. Remove orphans first (frees ids if the AI is renaming/relocating)
    existingOnTab.forEach((node, id) => {
      if (!newFlowIds.has(id)) {
        RED.nodes.remove(id)
      }
    })

    // 2. Import any flow nodes that don't exist yet
    const toAdd = flowNodes.filter(n => !existingOnTab.has(n.id))

    if (toAdd.length > 0) {
      RED.nodes.import(toAdd)
      toAdd.forEach(newNode => {
        const node = RED.nodes.node(newNode.id)

        if (node) {
          rewireNode(node, newNode.wires)
          node.changed = true
          node.dirty = true
          RED.events.emit('nodes:change', node)
        }
      })
    }

    // 3. Update existing flow nodes in place
    flowNodes.forEach(newNode => {
      const existing = existingOnTab.get(newNode.id)

      if (!existing) {
        return
      }

      const skipKeys = new Set(['id', 'type', 'z', 'x', 'y', 'wires'])

      Object.keys(newNode).forEach(key => {
        if (!skipKeys.has(key)) {
          existing[key] = newNode[key]
        }
      })

      if (newNode.x !== undefined) {
        existing.x = newNode.x
      }

      if (newNode.y !== undefined) {
        existing.y = newNode.y
      }

      rewireNode(existing, newNode.wires)
      existing.changed = true
      existing.dirty = true
      RED.events.emit('nodes:change', existing)
    })

    // 4. Config nodes: update in place or import
    configNodes.forEach(newConfig => {
      const existing = RED.nodes.node(newConfig.id)

      if (existing) {
        const skipKeys = new Set(['id', 'type'])

        Object.keys(newConfig).forEach(key => {
          if (!skipKeys.has(key)) {
            existing[key] = newConfig[key]
          }
        })
        existing.changed = true
        RED.events.emit('nodes:change', existing)
      } else {
        RED.nodes.import([newConfig])
      }
    })

    RED.nodes.dirty(true)
    RED.view.redraw(true)
  }

  const runAutoVerifyLoop = async ({
    prompt,
    promptId,
    initialFlow,
    targetTab,
    responseArea
  }) => {
    const {
      maxAttempts,
      maxRestarts,
      timeoutMs,
      canAutoDeploy
    } = autoVerifyState
    const entries = []
    const seenSignatures = new Set()
    const loopStartedAt = Date.now()
    let prevFlow = initialFlow
    let currFlow = initialFlow
    let restartNumber = 1
    let attemptInRestart = 0
    let terminal = null // null while running; 'success' | 'exhausted' | 'aborted'

    const attemptCount = () => entries.filter(e => (e.kind || 'attempt') === 'attempt').length

    const panel = initVerifyPanel(responseArea)
    const render = () => renderCorrectionLog(panel, entries)

    // Push the initial "Running…" log entry. It's a snapshot of the loop's
    // starting state — never updated. Progress is reflected by appending
    // attempt + restart entries below it, and a terminal entry at the end.
    const runningText = maxRestarts > 1
      ? `Restart 1 of ${maxRestarts} — Running auto-verify… (attempt 1 of ${maxAttempts})`
      : `Running auto-verify… (attempt 1 of ${maxAttempts})`

    entries.push({ kind: 'running', text: runningText })
    render()

    const pushTerminalEntry = () => {
      if (terminal === 'success') {
        const total = attemptCount()
        const text = (maxRestarts > 1 && restartNumber > 1)
          ? `Resolved on restart ${restartNumber} (attempt ${attemptInRestart} of ${maxAttempts}; ${total} total)`
          : `Resolved in ${total} attempt${total === 1 ? '' : 's'}`

        entries.push({ kind: 'terminal', outcome: 'success', text })
      } else {
        entries.push({ kind: 'terminal', outcome: 'unresolved', text: TERMINAL_FAILURE_MSG })
      }

      render()
    }

    // Request an AI correction for the current attempt, given the phase that
    // failed and its error signature. Returns true if a corrected flow was
    // applied to the editor, false if the attempt should be terminated.
    const requestCorrection = async ({
      attempt,
      phase,
      sig,
      diff
    }) => {
      try {
        // Note: deliberately NOT forwarding the original `context`. The server
        // uses `currentFlow` as the AI's "existing flow context" so the model
        // sees only the flow it's being asked to fix. No client-side timeout —
        // SFL_AUTO_VERIFY_TIMEOUT_MS is for the runtime observation window only.
        const { data } = await apiRequest(
          'POST',
          '/ai/auto-verify/correct',
          {
            prompt,
            currentFlow: currFlow,
            correctionDiff: JSON.stringify(diff),
            errorSummary: attempt.errorSummary,
            errorSignature: sig,
            attemptNumber: attempt.number + 1,
            phase
          }
        )

        if (data && data.success && Array.isArray(data.flow) && data.flow.length > 0) {
          prevFlow = currFlow
          currFlow = data.flow
          mergeFlowIntoTab(targetTab, currFlow)

          return true
        }

        attempt.outcomeText += '; AI returned no correction'
        render()
      } catch (err) {
        attempt.outcomeText += `; correction request failed (${err.message || 'error'})`
        render()
      }

      return false
    }

    // Generate a brand-new flow from scratch using the original prompt with no
    // context. Used between restarts after the inner attempts loop fails to
    // converge. Returns true if the new flow was applied to the editor.
    const regenerateFromScratch = async () => {
      try {
        const { data } = await apiRequest('POST', '/ai/build-flow', { prompt })

        if (data && data.success && Array.isArray(data.flow) && data.flow.length > 0) {
          prevFlow = currFlow
          currFlow = data.flow
          mergeFlowIntoTab(targetTab, currFlow)

          return true
        }
      } catch (err) {
        // fall through to false
      }

      return false
    }

    // Fire-and-forget audit emission for a single attempt outcome. Outcome
    // values are 'resolved' | 'unresolved' | 'same_signature_repeated' per spec.
    const emitAttempt = (attempt, outcome, errors, kind) => {
      emitAudit({
        event_type: 'auto_verify_attempt',
        prompt_id: promptId,
        timestamp: new Date().toISOString(),
        attempt_number: attempt.number,
        mode: kind || attempt.phase || 'syntax',
        error_signature: errors && errors.length ? auditErrorSignature(errors, kind || attempt.phase || 'syntax') : '',
        error_message: attempt.errorSummary || '',
        correction_summary: attempt.changeSummary || '',
        outcome
      })
    }

    // Run one restart's worth of attempts. Returns:
    //   'success'   — clean syntax + clean runtime
    //   'exhausted' — hit maxAttempts without success
    //   'converged' — same error signature repeated
    //   'aborted'   — AI/network failure mid-correction
    const runAttemptsForRestart = async () => {
      for (let i = 1; i <= maxAttempts; i += 1) {
        attemptInRestart = i
        const attemptStart = Date.now()
        const isFirstAttemptOfFirstRestart = restartNumber === 1 && i === 1
        const isFirstAttemptOfLaterRestart = restartNumber > 1 && i === 1
        const diff = isFirstAttemptOfFirstRestart
          ? { added: [], removed: [], modified: [] }
          : computeFlowDiff(prevFlow, currFlow)
        let changeSummary

        if (isFirstAttemptOfFirstRestart) {
          changeSummary = 'initial AI-generated flow'
        } else if (isFirstAttemptOfLaterRestart) {
          changeSummary = 'fresh regenerated flow'
        } else {
          changeSummary = summarizeDiff(diff)
        }

        const attempt = {
          kind: 'attempt',
          number: i,
          restartNumber,
          phase: 'syntax',
          errorSummary: '',
          changeSummary,
          outcome: 'pending',
          outcomeText: 'checking syntax…'
        }

        entries.push(attempt)
        render()

        // ===== Phase A: Syntax =====
        const syntaxErrors = runSyntaxCheck(targetTab, currFlow)

        if (syntaxErrors.length) {
          const sig = `syntax:${errorSignature(syntaxErrors)}`

          attempt.errorSummary = summarizeErrors(syntaxErrors)
          attempt.outcome = 'invalid'
          attempt.outcomeText = `syntax check failed (${syntaxErrors.length} issue${syntaxErrors.length === 1 ? '' : 's'})`
          render()

          if (seenSignatures.has(sig)) {
            attempt.outcome = 'converged'
            attempt.outcomeText = 'same syntax error as a previous attempt — stopping this restart'
            render()
            emitAttempt(attempt, 'same_signature_repeated', syntaxErrors, 'syntax')

            return 'converged'
          }

          seenSignatures.add(sig)

          if (i === maxAttempts) {
            emitAttempt(attempt, 'unresolved', syntaxErrors, 'syntax')

            return 'exhausted'
          }

          emitAttempt(attempt, 'unresolved', syntaxErrors, 'syntax')

          // eslint-disable-next-line no-await-in-loop
          const applied = await requestCorrection({
            attempt,
            phase: 'syntax',
            sig,
            diff
          })

          if (!applied) {
            return 'aborted'
          }

          continue // eslint-disable-line no-continue
        }

        // ===== Phase B: Runtime =====
        attempt.phase = 'runtime'
        attempt.outcomeText = 'syntax clean; preparing runtime check…'
        render()

        if (!canAutoDeploy) {
          attempt.outcome = 'success'
          attempt.outcomeText = 'syntax clean; auto-deploy gate closed (validation-only success)'
          render()
          emitAttempt(attempt, 'resolved', [], 'runtime')

          return 'success'
        }

        // eslint-disable-next-line no-await-in-loop
        const deployed = await triggerDeploy()

        if (!deployed) {
          attempt.outcome = 'success'
          attempt.outcomeText = 'syntax clean; deploy action unavailable (validation-only success)'
          render()
          emitAttempt(attempt, 'resolved', [], 'runtime')

          return 'success'
        }

        attempt.outcomeText = `deployed; observing runtime for ${timeoutMs}ms…`
        render()

        const remaining = Math.max(1000, timeoutMs - (Date.now() - attemptStart))
        // eslint-disable-next-line no-await-in-loop
        const runtimeErrors = await observeRuntimeErrors(remaining, targetTab)

        if (runtimeErrors.length === 0) {
          attempt.outcome = 'success'
          attempt.outcomeText = 'deployed; no runtime errors observed'
          render()
          emitAttempt(attempt, 'resolved', [], 'runtime')

          return 'success'
        }

        const summaries = runtimeErrors.map(e => `${e.source || e.id}: ${e.msg}`)
        const sig = `runtime:${errorSignature(summaries)}`

        attempt.errorSummary = summarizeErrors(summaries)
        attempt.outcome = 'runtime-error'
        attempt.outcomeText = `runtime errors detected (${runtimeErrors.length})`
        render()

        if (seenSignatures.has(sig)) {
          attempt.outcome = 'converged'
          attempt.outcomeText = 'same runtime error as a previous attempt — stopping this restart'
          render()
          emitAttempt(attempt, 'same_signature_repeated', summaries, 'runtime')

          return 'converged'
        }

        seenSignatures.add(sig)

        if (i === maxAttempts) {
          emitAttempt(attempt, 'unresolved', summaries, 'runtime')

          return 'exhausted'
        }

        emitAttempt(attempt, 'unresolved', summaries, 'runtime')

        // eslint-disable-next-line no-await-in-loop
        const applied = await requestCorrection({
          attempt,
          phase: 'runtime',
          sig,
          diff
        })

        if (!applied) {
          return 'aborted'
        }
      }

      return 'exhausted'
    }

    // Map the loop's terminal state onto the audit `outcome` taxonomy and
    // emit auto_verify_complete exactly once.
    let lastInnerStatus = null
    let resampleTriggered = false
    const emitComplete = () => {
      let outcome
      if (terminal === 'success') {
        outcome = 'resolved'
      } else if (resampleTriggered) {
        outcome = 'unresolved_after_resample'
      } else if (lastInnerStatus === 'converged') {
        outcome = 'signature_repeated'
      } else {
        outcome = 'ceiling_hit'
      }

      emitAudit({
        event_type: 'auto_verify_complete',
        prompt_id: promptId,
        timestamp: new Date().toISOString(),
        outcome,
        total_attempts: attemptCount(),
        resample_triggered: resampleTriggered,
        final_flow_id: targetTab || null,
        duration_ms: Date.now() - loopStartedAt
      })
    }

    while (restartNumber <= maxRestarts) {
      if (restartNumber > 1) {
        resampleTriggered = true
        entries.push({
          kind: 'restart',
          restartNumber,
          totalRestarts: maxRestarts
        })
        render()

        // eslint-disable-next-line no-await-in-loop
        const regenerated = await regenerateFromScratch()

        if (!regenerated) {
          terminal = 'aborted'
          pushTerminalEntry()
          emitComplete()

          return
        }
      }

      // eslint-disable-next-line no-await-in-loop
      const status = await runAttemptsForRestart()

      lastInnerStatus = status

      if (status === 'success') {
        terminal = 'success'
        pushTerminalEntry()
        emitComplete()

        return
      }

      if (status === 'aborted') {
        terminal = 'aborted'
        pushTerminalEntry()
        emitComplete()

        return
      }

      // status is 'exhausted' or 'converged' — try the next restart, if any.
      if (restartNumber === maxRestarts) {
        terminal = 'exhausted'
        pushTerminalEntry()
        emitComplete()

        return
      }

      restartNumber += 1
    }

    render()
    emitComplete()
  }

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

    // Call AI service via jQuery (Node-RED ships jQuery in the editor)
    apiRequest(
      'POST',
      '/ai/build-flow',
      {
        prompt,
        context: context.hasNodes && !shouldCreateNewTab ? context : undefined
      }
    ).then(({ data }) => {
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

        RED.notify('Flow built from AI prompt', 'success')
        // Mark flow as modified
        RED.nodes.dirty(true)

        // Auto-verify: run the self-correction loop if the toggle is on.
        // Return the promise so the outer .finally() waits for it before
        // re-enabling the Build Flow button. The verify loop owns the
        // response panel from this point on — don't write a success message
        // here or it will overwrite the loop's first render.
        const toggle = $('#ai-auto-verify-toggle')
        const autoVerifyOn = toggle.length ? !!toggle.prop('checked') : autoVerifyState.autoVerifyDefault

        if (autoVerifyOn) {
          return runAutoVerifyLoop({
            prompt,
            // `data.promptId` is generated server-side at /ai/build-flow and
            // ties subsequent audit events (auto_verify_attempt, complete)
            // back to the original prompt_received event.
            promptId: data.promptId,
            initialFlow: data.flow,
            targetTab,
            responseArea,
            context
          }).catch(err => {
            console.error('[ai-flow-builder] auto-verify loop error', err)
          })
        }

        // No auto-verify — show the legacy summary message.
        let successMsg = `Flow ${shouldCreateNewTab ? 'created' : 'updated'} successfully! Generated ${data.flow.length} nodes`

        if (data.metadata) {
          if (data.metadata.usage) {
            successMsg += `\nTokens used: ${data.metadata.usage.total_tokens}`
          }

          if (data.metadata.citations && data.metadata.citations.length > 0) {
            successMsg += `\nUsed ${data.metadata.citations.length} documentation sources`
          }
        }

        responseArea.append(successMsg).show()
      } else {
        responseArea.append('AI returned empty flow. Try rephrasing your prompt.')
        RED.notify('No nodes generated', 'warning')
      }
    }).catch(err => {
      const errorDetail = err.response?.data?.error
      // status 0 = no response reached the browser at all (server restarted or
      // was redeployed mid-request, proxy dropped the connection, or the page was
      // reloaded). That is a transport failure, not a configuration problem.
      const connectionLost = err.response && err.response.status === 0
      const statusText = err.response
        ? `HTTP ${err.response.status}: ${err.response.statusText || 'Request failed'}`
        : err.message
      const errorMsg = connectionLost
        ? 'Error: Connection lost before the server responded.\n\nThe server was most likely restarted or redeployed while the flow was being generated. Nothing is misconfigured — just try again.'
        : `Error: ${errorDetail || statusText}\n\nPlease check:\n- AI connector is configured\n- API keys are valid\n- Network connection is stable`

      responseArea.append(errorMsg).show()
      RED.notify('Failed to build flow', 'error')
      console.error('[ai-flow-builder] Error:', err)
    }).finally(() => {
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

    // Auto-verify toggle row.
    // Hidden by default — fetchAutoVerifySettings() reveals it only when the
    // server reports canAutoDeploy=true (NODE_ENV is set and not "production").
    // If we can't deploy, there's no value in offering the switch.
    const autoVerifyRow = $('<label>', { class: 'ai-auto-verify-row' }).hide()
    const autoVerifyInput = $('<input>', {
      id: 'ai-auto-verify-toggle',
      type: 'checkbox',
      class: 'ai-auto-verify-checkbox',
      switch: true
    }).prop('checked', false)

    autoVerifyInput.on('change', () => {
      autoVerifyInput.data('user-changed', true)
    })

    autoVerifyRow
      .append(autoVerifyInput)
      .append($('<span>', { class: 'ai-auto-verify-label', text: 'auto-verify' }))

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
    container
      .append(helpText)
      .append(promptArea)
      .append(autoVerifyRow)
      .append(responseArea)
      .append(buttonContainer)

    fetchAutoVerifySettings()

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

    const safeStorage = {
      get(key) {
        try { return localStorage.getItem(key) } catch { return null }
      },
      set(key, val) {
        try { localStorage.setItem(key, val) } catch {
          // Ignore
        }
      }
    }

    // Function to show and configure the sidebar
    const configureSidebar = () => {
      console.log('[ai-prompt-sidebar] Configuring sidebar')
      const lastTab = safeStorage.get('red-ui-last-sidebar-tab')

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
            safeStorage.set('red-ui-last-sidebar-tab', tabId)
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
