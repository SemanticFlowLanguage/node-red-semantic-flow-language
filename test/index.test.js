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

  test('registers endpoints and build-flow handler responds', async () => {
    const registerPlugin = jest.fn()
    const httpAdminPost = jest.fn()
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    }
    const httpAdminGet = jest.fn()
    const RED = {
      settings: {},
      log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      httpAdmin: { post: httpAdminPost, get: httpAdminGet },
      plugins: { registerPlugin }
    }

    // eslint-disable-next-line global-require
    const pluginEntry = require('../index')
    await pluginEntry(RED)

    expect(registerPlugin).toHaveBeenCalled()
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
})
