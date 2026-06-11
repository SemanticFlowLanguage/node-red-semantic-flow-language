// Audit Trail Emission
//
// Single configurable destination controlled by SFL_AUDIT_DESTINATION:
//   blank/unset → silent (no emission). Default for plugin portability.
//   "red.log"   → RED.log.info(JSON.stringify(event))
//   http(s)://… → POST JSON payload to the URL
//   anything else → treated as a file path; appended as JSONL. Relative paths
//                   resolve against RED.settings.userDir (the .node-red dir).
//
// All emission is fire-and-forget. Failures are logged via RED.log.warn so
// operators notice, but never throw or block callers.
const fs = require('fs')
const path = require('path')
const os = require('os')
const axios = require('axios')
const crypto = require('crypto')
const getEnv = require('./config-loader')

const URL_QUEUE_MAX = 100
const URL_RETRY_DELAY_MS = 500
const URL_REQUEST_TIMEOUT_MS = 10000

let REDref = null
let urlQueueSize = 0

const setRED = redInstance => {
  REDref = redInstance
}

const warn = msg => {
  if (REDref && REDref.log && typeof REDref.log.warn === 'function') {
    REDref.log.warn(`[sfl-audit] ${msg}`)
  }
}

const userDir = () => {
  if (REDref && REDref.settings && REDref.settings.userDir) {
    return REDref.settings.userDir
  }

  return path.join(os.homedir(), '.node-red')
}

const generatePromptId = () => {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `prompt-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 14)}`
}

// User identity from req.user (set by RED.auth middleware when auth is on).
// Order: email → username/UPN → id → none. Captured FRESH on each event write
// per the spec — not memoised at request entry.
const extractUserInfo = req => {
  const candidate = req && (req.user || (req.session && req.session.user))

  if (!candidate || typeof candidate !== 'object') {
    return { user: null, user_source: 'none' }
  }

  if (candidate.email) {
    return { user: candidate.email, user_source: 'email' }
  }

  if (candidate.username) {
    return { user: candidate.username, user_source: 'username' }
  }

  if (candidate.upn) {
    return { user: candidate.upn, user_source: 'username' }
  }

  if (candidate.id || candidate.userId) {
    return { user: candidate.id || candidate.userId, user_source: 'id' }
  }

  return { user: null, user_source: 'none' }
}

const resolveDestination = () => {
  const raw = getEnv('SFL_AUDIT_DESTINATION', '')
  const dest = typeof raw === 'string' ? raw.trim() : ''

  if (!dest) {
    return { kind: 'none' }
  }

  if (dest === 'red.log') {
    return { kind: 'red.log' }
  }

  if (/^https?:\/\//i.test(dest)) {
    return { kind: 'url', url: dest }
  }

  const filePath = path.isAbsolute(dest) ? dest : path.join(userDir(), dest)

  return { kind: 'file', filePath }
}

const writeToFile = (filePath, event) => {
  const line = `${JSON.stringify(event)}\n`

  fs.appendFile(filePath, line, err => {
    if (err) {
      warn(`file append failed (${filePath}): ${err.message}`)
    }
  })
}

const writeToRedLog = event => {
  if (REDref && REDref.log && typeof REDref.log.info === 'function') {
    REDref.log.info(JSON.stringify(event))
  }
}

const getAuditHeaders = () => {
  const raw = getEnv('SFL_AUDIT_HEADERS', {})

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw
  }

  return {}
}

const postToUrl = (url, event, attempt) => {
  // verify TLS by default — axios defaults to that, do not disable.
  axios.post(url, event, {
    headers: { 'Content-Type': 'application/json', ...getAuditHeaders() },
    timeout: URL_REQUEST_TIMEOUT_MS
  })
    .then(() => {
      urlQueueSize -= 1
    })
    .catch(err => {
      const status = err && err.response && err.response.status
      const isTransient = !status || status >= 500 || err.code === 'ECONNABORTED'

      if (isTransient && attempt === 0) {
        setTimeout(() => postToUrl(url, event, 1), URL_RETRY_DELAY_MS)

        return
      }

      urlQueueSize -= 1
      warn(`URL emit failed (${url}): ${err.message}`)
    })
}

const writeToUrl = (url, event) => {
  if (urlQueueSize >= URL_QUEUE_MAX) {
    warn(`URL queue full (${URL_QUEUE_MAX}); dropping event ${event.event_type}`)

    return
  }

  urlQueueSize += 1
  postToUrl(url, event, 0)
}

// Build a complete audit envelope. Adds timestamp + user fields if missing.
const buildEvent = (partial, req) => {
  const userInfo = extractUserInfo(req)
  const event = {
    timestamp: partial.timestamp || new Date().toISOString(),
    ...partial
  }

  // Always overwrite user fields server-side (spec: capture fresh on write).
  event.user = userInfo.user
  event.user_source = userInfo.user_source

  return event
}

// Fire-and-forget emission. Never throws.
const emit = (partial, req) => {
  try {
    const dest = resolveDestination()

    if (dest.kind === 'none') {
      return
    }

    const event = buildEvent(partial, req)

    if (dest.kind === 'red.log') {
      writeToRedLog(event)
    } else if (dest.kind === 'file') {
      writeToFile(dest.filePath, event)
    } else if (dest.kind === 'url') {
      writeToUrl(dest.url, event)
    }
  } catch (err) {
    warn(`emit failed: ${err.message}`)
  }
}

module.exports = {
  setRED,
  emit,
  generatePromptId,
  extractUserInfo,
  resolveDestination
}
