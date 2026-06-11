// Use jest.spyOn rather than jest.mock — spying patches the real module object
// in place, so both the test scope and the audit module see the same spy. The
// jest.mock factory approach was returning fresh objects per require, leaving
// the audit module looking at a different axios.post than the test.
const axios = require('axios')
const fs = require('fs')
const audit = require('../resources/audit')
const getEnv = require('../resources/config-loader')

const flushMicrotasks = () => new Promise(resolve => { setImmediate(resolve) })

describe('audit module', () => {
  const originalEnv = { ...process.env }
  let mockRED
  let axiosPostSpy
  let fsAppendSpy

  beforeEach(() => {
    axiosPostSpy = jest.spyOn(axios, 'post').mockResolvedValue({ status: 200 })
    fsAppendSpy = jest.spyOn(fs, 'appendFile').mockImplementation((p, c, cb) => cb && cb(null))

    process.env = { ...originalEnv }
    delete process.env.SFL_AUDIT_DESTINATION
    delete process.env.SFL_AUDIT_HEADERS

    mockRED = {
      settings: { userDir: '/test/.node-red' },
      log: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
      }
    }
    audit.setRED(mockRED)
    getEnv.setSettings(mockRED.settings)
  })

  afterEach(() => {
    axiosPostSpy.mockRestore()
    fsAppendSpy.mockRestore()
  })

  afterAll(() => {
    process.env = originalEnv
  })

  describe('resolveDestination', () => {
    test('returns none when unset', () => {
      expect(audit.resolveDestination()).toEqual({ kind: 'none' })
    })

    test('returns none when blank string', () => {
      process.env.SFL_AUDIT_DESTINATION = ''
      expect(audit.resolveDestination()).toEqual({ kind: 'none' })
    })

    test('returns none when only whitespace', () => {
      process.env.SFL_AUDIT_DESTINATION = '   '
      expect(audit.resolveDestination()).toEqual({ kind: 'none' })
    })

    test('returns red.log for the reserved token', () => {
      process.env.SFL_AUDIT_DESTINATION = 'red.log'
      expect(audit.resolveDestination()).toEqual({ kind: 'red.log' })
    })

    test('returns url for http://...', () => {
      process.env.SFL_AUDIT_DESTINATION = 'http://example.com/audit'
      expect(audit.resolveDestination()).toEqual({
        kind: 'url',
        url: 'http://example.com/audit'
      })
    })

    test('returns url for https://...', () => {
      process.env.SFL_AUDIT_DESTINATION = 'https://example.com/audit'
      expect(audit.resolveDestination()).toEqual({
        kind: 'url',
        url: 'https://example.com/audit'
      })
    })

    test('treats absolute path as file', () => {
      process.env.SFL_AUDIT_DESTINATION = '/var/log/sfl-audit.jsonl'
      expect(audit.resolveDestination()).toEqual({
        kind: 'file',
        filePath: '/var/log/sfl-audit.jsonl'
      })
    })

    test('resolves relative path against RED user directory', () => {
      process.env.SFL_AUDIT_DESTINATION = 'audit/events.jsonl'
      const r = audit.resolveDestination()
      expect(r.kind).toBe('file')
      expect(r.filePath).toBe('/test/.node-red/audit/events.jsonl')
    })
  })

  describe('extractUserInfo', () => {
    test('returns none for null req', () => {
      expect(audit.extractUserInfo(null)).toEqual({ user: null, user_source: 'none' })
    })

    test('returns none for req without user', () => {
      expect(audit.extractUserInfo({})).toEqual({ user: null, user_source: 'none' })
    })

    test('returns none when req.user is a non-object', () => {
      expect(audit.extractUserInfo({ user: 'not-an-object' }))
        .toEqual({ user: null, user_source: 'none' })
    })

    test('prefers email over everything', () => {
      const req = { user: { email: 'a@b.c', username: 'a', upn: 'a@b', id: '1' } }
      expect(audit.extractUserInfo(req)).toEqual({ user: 'a@b.c', user_source: 'email' })
    })

    test('falls back to username when no email', () => {
      const req = { user: { username: 'alice', id: '1' } }
      expect(audit.extractUserInfo(req)).toEqual({ user: 'alice', user_source: 'username' })
    })

    test('treats upn as a username source', () => {
      const req = { user: { upn: 'alice@example.com', id: '1' } }
      expect(audit.extractUserInfo(req)).toEqual({
        user: 'alice@example.com',
        user_source: 'username'
      })
    })

    test('falls back to id when no email/username/upn', () => {
      const req = { user: { id: 'user-123' } }
      expect(audit.extractUserInfo(req)).toEqual({ user: 'user-123', user_source: 'id' })
    })

    test('accepts userId as alternative to id', () => {
      const req = { user: { userId: 'user-456' } }
      expect(audit.extractUserInfo(req)).toEqual({ user: 'user-456', user_source: 'id' })
    })

    test('reads from req.session.user when req.user is absent', () => {
      const req = { session: { user: { email: 'a@b.c' } } }
      expect(audit.extractUserInfo(req)).toEqual({ user: 'a@b.c', user_source: 'email' })
    })
  })

  describe('emit (synchronous paths)', () => {
    test('silent destination is a no-op across all sinks', () => {
      audit.emit({ event_type: 'prompt_received' }, {})
      expect(mockRED.log.info).not.toHaveBeenCalled()
      expect(fsAppendSpy).not.toHaveBeenCalled()
      expect(axiosPostSpy).not.toHaveBeenCalled()
    })

    test('red.log mode writes JSON string via RED.log.info', () => {
      process.env.SFL_AUDIT_DESTINATION = 'red.log'
      audit.emit(
        { event_type: 'prompt_received', prompt_id: 'p1' },
        { user: { email: 'a@b.c' } }
      )
      expect(mockRED.log.info).toHaveBeenCalledTimes(1)

      const parsed = JSON.parse(mockRED.log.info.mock.calls[0][0])
      expect(parsed.event_type).toBe('prompt_received')
      expect(parsed.prompt_id).toBe('p1')
      expect(parsed.user).toBe('a@b.c')
      expect(parsed.user_source).toBe('email')
      expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    })

    test('stamps timestamp only when missing', () => {
      process.env.SFL_AUDIT_DESTINATION = 'red.log'

      audit.emit({ event_type: 'prompt_received' }, {})
      const stamped = JSON.parse(mockRED.log.info.mock.calls[0][0])
      expect(stamped.timestamp).toBeTruthy()

      mockRED.log.info.mockClear()
      audit.emit(
        { event_type: 'prompt_received', timestamp: '2026-01-01T00:00:00.000Z' },
        {}
      )
      const preserved = JSON.parse(mockRED.log.info.mock.calls[0][0])
      expect(preserved.timestamp).toBe('2026-01-01T00:00:00.000Z')
    })

    test('overwrites user fields fresh on each write (anti-spoof)', () => {
      process.env.SFL_AUDIT_DESTINATION = 'red.log'
      audit.emit(
        { event_type: 'prompt_received', user: 'forged@evil.com', user_source: 'email' },
        { user: { id: 'real-id' } }
      )
      const parsed = JSON.parse(mockRED.log.info.mock.calls[0][0])
      expect(parsed.user).toBe('real-id')
      expect(parsed.user_source).toBe('id')
    })

    test('file mode appends a JSONL line', () => {
      process.env.SFL_AUDIT_DESTINATION = '/tmp/sfl-audit.jsonl'
      audit.emit({ event_type: 'prompt_received', prompt_id: 'p1' }, {})

      expect(fsAppendSpy).toHaveBeenCalledTimes(1)
      const [filePath, line, cb] = fsAppendSpy.mock.calls[0]
      expect(filePath).toBe('/tmp/sfl-audit.jsonl')
      expect(line.endsWith('\n')).toBe(true)
      const parsed = JSON.parse(line.trim())
      expect(parsed.event_type).toBe('prompt_received')
      expect(parsed.prompt_id).toBe('p1')
      expect(typeof cb).toBe('function')
    })

    test('file mode warns on appendFile failure but never throws', () => {
      process.env.SFL_AUDIT_DESTINATION = '/tmp/sfl-audit.jsonl'
      fsAppendSpy.mockImplementationOnce((p, c, cb) => cb(new Error('disk full')))

      expect(() => audit.emit({ event_type: 'prompt_received' }, {})).not.toThrow()
      expect(mockRED.log.warn).toHaveBeenCalledWith(expect.stringContaining('disk full'))
    })

    test('emit never throws when sink itself fails', () => {
      process.env.SFL_AUDIT_DESTINATION = 'red.log'
      mockRED.log.info.mockImplementation(() => { throw new Error('log explosion') })

      expect(() => audit.emit({ event_type: 'prompt_received' }, {})).not.toThrow()
      expect(mockRED.log.warn).toHaveBeenCalledWith(expect.stringContaining('emit failed'))
    })
  })

  describe('emit (URL mode)', () => {
    test('url mode posts JSON with default Content-Type', async () => {
      process.env.SFL_AUDIT_DESTINATION = 'https://example.com/audit'
      audit.emit({ event_type: 'prompt_received' }, {})

      expect(axiosPostSpy).toHaveBeenCalledTimes(1)
      const [url, body, config] = axiosPostSpy.mock.calls[0]
      expect(url).toBe('https://example.com/audit')
      expect(body.event_type).toBe('prompt_received')
      expect(config.headers['Content-Type']).toBe('application/json')

      await flushMicrotasks()
    })

    test('url mode merges SFL_AUDIT_HEADERS from RED.settings', async () => {
      process.env.SFL_AUDIT_DESTINATION = 'https://example.com/audit'
      mockRED.settings.SFL_AUDIT_HEADERS = { 'X-API-Key': 'secret', 'X-Trace': 'abc' }
      getEnv.setSettings(mockRED.settings)

      audit.emit({ event_type: 'prompt_received' }, {})

      expect(axiosPostSpy).toHaveBeenCalledTimes(1)
      const [, , config] = axiosPostSpy.mock.calls[0]
      expect(config.headers['X-API-Key']).toBe('secret')
      expect(config.headers['X-Trace']).toBe('abc')
      expect(config.headers['Content-Type']).toBe('application/json')

      await flushMicrotasks()
    })

    test('url mode warns on non-transient failure', async () => {
      process.env.SFL_AUDIT_DESTINATION = 'https://example.com/audit'
      const err = new Error('bad request')
      err.response = { status: 400 }
      axiosPostSpy.mockReset()
      axiosPostSpy.mockRejectedValue(err)

      expect(() => audit.emit({ event_type: 'prompt_received' }, {})).not.toThrow()

      await flushMicrotasks()
      expect(mockRED.log.warn).toHaveBeenCalledWith(expect.stringContaining('URL emit failed'))
      expect(axiosPostSpy).toHaveBeenCalledTimes(1)
    })

    // Last on purpose — leaves urlQueueSize at the cap, which would break any
    // url-mode test that runs after it.
    test('url mode drops events when the queue is full', () => {
      process.env.SFL_AUDIT_DESTINATION = 'https://example.com/audit'
      axiosPostSpy.mockReset()
      axiosPostSpy.mockReturnValue(new Promise(() => { /* hang */ }))

      for (let i = 0; i < 100; i += 1) {
        audit.emit({ event_type: 'prompt_received', n: i }, {})
      }
      expect(axiosPostSpy).toHaveBeenCalledTimes(100)
      expect(mockRED.log.warn).not.toHaveBeenCalled()

      audit.emit({ event_type: 'prompt_received', n: 100 }, {})
      expect(axiosPostSpy).toHaveBeenCalledTimes(100)
      expect(mockRED.log.warn).toHaveBeenCalledWith(expect.stringContaining('queue full'))
    })
  })

  describe('generatePromptId', () => {
    test('returns a non-empty string', () => {
      const id = audit.generatePromptId()
      expect(typeof id).toBe('string')
      expect(id.length).toBeGreaterThan(0)
    })

    test('returns unique values across many calls', () => {
      const ids = new Set()
      for (let i = 0; i < 50; i += 1) {
        ids.add(audit.generatePromptId())
      }
      expect(ids.size).toBe(50)
    })
  })
})
