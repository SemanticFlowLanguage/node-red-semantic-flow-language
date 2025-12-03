describe('node-tooltip plugin', () => {
  let registered
  const originalTimeout = global.setTimeout

  beforeEach(() => {
    jest.resetModules()
    registered = null
    global.setTimeout = jest.fn()
    global.window = { tippy: {} }
    global.tippy = global.window.tippy
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
    delete global.tippy
  })

  test('registers tooltip plugin and attaches event listeners', () => {
    // eslint-disable-next-line global-require
    require('../resources/node-tooltip.js')

    expect(registered).toBeTruthy()
    expect(typeof registered.onadd).toBe('function')
    expect(() => registered.onadd()).not.toThrow()
    expect(RED.events.on).toHaveBeenCalled()
    expect(RED.events.on).toHaveBeenCalledWith('editor:open', expect.any(Function))
  })
})
