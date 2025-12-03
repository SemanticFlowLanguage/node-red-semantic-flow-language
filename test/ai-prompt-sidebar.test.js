describe('ai-prompt-sidebar plugin', () => {
  let registered
  const originalTimeout = global.setTimeout

  beforeEach(() => {
    jest.resetModules()
    registered = null
    global.setTimeout = jest.fn()
    global.localStorage = {
      getItem: jest.fn(),
      setItem: jest.fn()
    }
    global.window = { axios: { post: jest.fn() } }
    global.RED = {
      plugins: {
        registerPlugin: jest.fn((name, plugin) => {
          registered = plugin
        })
      },
      events: { on: jest.fn() }
    }
  })

  afterEach(() => {
    global.setTimeout = originalTimeout
    delete global.RED
    delete global.window
    delete global.localStorage
  })

  test('registers the sidebar plugin without throwing', () => {
    // eslint-disable-next-line global-require
    require('../resources/ai-prompt-sidebar.js')

    expect(registered).toBeTruthy()
    expect(typeof registered.onadd).toBe('function')

    expect(() => registered.onadd()).not.toThrow()
    expect(RED.events.on).toHaveBeenCalledWith('runtime-state', expect.any(Function))
  })
})
