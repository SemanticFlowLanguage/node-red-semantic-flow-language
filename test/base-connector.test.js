describe('base connector contract', () => {
  test('throws for unimplemented methods', () => {
    // eslint-disable-next-line global-require
    const base = require('../resources/ai-connectors/base-connector')

    expect(() => base.getConfig()).toThrow()
    expect(() => base.validateConfig()).toThrow()
    expect(base.name).toBe('base')
  })
})
