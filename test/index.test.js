jest.mock('../resources/ai-connectors/azure-openai-connector-node', () => ({
  getConfig: jest.fn(() => ({})),
  validateConfig: jest.fn(() => ({ valid: true, errors: [] })),
  generateFlow: jest.fn().mockResolvedValue({ success: true, flow: [] }),
  resyncNode: jest.fn().mockResolvedValue({ success: true, updatedNode: { id: '1' } }),
  generateDescription: jest.fn().mockResolvedValue({
    success: true,
    name: 'node',
    description: 'desc'
  })
}))

describe('index plugin entry', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    jest.resetModules()
    process.env = { ...originalEnv, AI_CONNECTOR: 'azure-openai' }
  })

  afterAll(() => {
    process.env = originalEnv
  })

  const makeRED = () => {
    const httpAdminPost = jest.fn()
    const httpAdminGet = jest.fn()

    return {
      RED: {
        settings: {},
        log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        httpAdmin: { post: httpAdminPost, get: httpAdminGet },
        plugins: { registerPlugin: jest.fn() }
      },
      httpAdminPost,
      httpAdminGet
    }
  }

  test('registers endpoints and build-flow handler responds', async () => {
    const { RED, httpAdminPost, httpAdminGet } = makeRED()
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    // eslint-disable-next-line global-require
    const pluginEntry = require('../index')
    await pluginEntry(RED)

    expect(RED.plugins.registerPlugin).toHaveBeenCalled()
    expect(httpAdminPost).toHaveBeenCalledTimes(6)
    expect(httpAdminGet).toHaveBeenCalledTimes(1)

    const settingsCall = httpAdminGet.mock.calls.find(call => call[0] === '/ai/auto-verify/settings')
    expect(settingsCall).toBeTruthy()

    const [, settingsHandler] = settingsCall
    settingsHandler({}, res)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      settings: expect.objectContaining({
        autoVerifyDefault: expect.any(Boolean),
        maxAttempts: expect.any(Number),
        timeoutMs: expect.any(Number),
        canAutoDeploy: expect.any(Boolean)
      })
    }))

    const buildFlowCall = httpAdminPost.mock.calls.find(call => call[0] === '/ai/build-flow')
    expect(buildFlowCall).toBeTruthy()

    const [, buildFlowHandler] = buildFlowCall
    await buildFlowHandler({ body: { prompt: 'test prompt' } }, res)

    expect(res.json).toHaveBeenCalled()
  })

  describe('connector loader', () => {
    test('AI_CONNECTOR_MODULE takes precedence over the built-in', async () => {
      // Absolute path to a real fixture so both require.resolve() and require()
      // succeed. jest.doMock({virtual:true}) only intercepts require(), not
      // require.resolve(), which the loader calls first.
      // eslint-disable-next-line global-require
      const fixturePath = require.resolve('./fixtures/fake-connector')
      process.env.AI_CONNECTOR_MODULE = fixturePath

      const { RED, httpAdminPost } = makeRED()
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

      // eslint-disable-next-line global-require
      const pluginEntry = require('../index')
      await pluginEntry(RED)

      const [, buildFlowHandler] = httpAdminPost.mock.calls
        .find(call => call[0] === '/ai/build-flow')
      await buildFlowHandler({ body: { prompt: 'hi' } }, res)

      // The fixture returned success with a distinctive node id — assert on the
      // response shape so we know the fixture's generateFlow ran.
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        flow: expect.arrayContaining([expect.objectContaining({ id: 'from-fixture' })])
      }))

      // The mocked built-in must NOT have been used.
      // eslint-disable-next-line global-require
      const builtIn = require('../resources/ai-connectors/azure-openai-connector-node')
      expect(builtIn.generateFlow).not.toHaveBeenCalled()
    })

    test('endpoints return 503 when no connector could be loaded', async () => {
      // Force all three fallback attempts to fail: unknown built-in name +
      // nothing set for AI_CONNECTOR_MODULE + no matching bare package.
      process.env.AI_CONNECTOR = 'no-such-connector-does-not-exist'
      delete process.env.AI_CONNECTOR_MODULE

      const { RED, httpAdminPost } = makeRED()
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

      // eslint-disable-next-line global-require
      const pluginEntry = require('../index')
      await pluginEntry(RED)

      expect(RED.log.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load connector')
      )

      const [, buildFlowHandler] = httpAdminPost.mock.calls
        .find(call => call[0] === '/ai/build-flow')
      await buildFlowHandler({ body: { prompt: 'hi' } }, res)

      expect(res.status).toHaveBeenCalledWith(503)
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.stringContaining('failed to load')
      }))
    })
  })
})
