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
    const RED = {
      settings: {},
      log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      httpAdmin: { post: httpAdminPost },
      plugins: { registerPlugin }
    }

    // eslint-disable-next-line global-require
    const pluginEntry = require('../index')
    pluginEntry(RED)

    expect(registerPlugin).toHaveBeenCalled()
    expect(httpAdminPost).toHaveBeenCalledTimes(4)

    const buildFlowCall = httpAdminPost.mock.calls.find(call => call[0] === '/ai/build-flow')
    expect(buildFlowCall).toBeTruthy()

    const [, buildFlowHandler] = buildFlowCall
    await buildFlowHandler({ body: { prompt: 'test prompt' } }, res)

    expect(res.json).toHaveBeenCalled()
  })
})
