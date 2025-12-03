const mockedDotenv = { config: jest.fn() }

jest.mock('dotenv', () => mockedDotenv)
jest.mock('fs', () => ({
  existsSync: jest.fn(() => false)
}))

describe('config-loader', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    jest.resetModules()
    mockedDotenv.config.mockClear()
    const fs = require('fs')
    fs.existsSync.mockReturnValue(false)
    process.env = { ...originalEnv }
  })

  afterAll(() => {
    process.env = originalEnv
  })

  test('returns fallback when no env or settings', () => {
    const getEnv = require('../resources/config-loader')

    const value = getEnv('MISSING_KEY', 'fallback-value')

    expect(value).toBe('fallback-value')
    expect(mockedDotenv.config).toHaveBeenCalled()
  })

  test('merges settings overrides and prompts into process.env', () => {
    const getEnv = require('../resources/config-loader')
    const settings = {
      aiPrompts: { SAMPLE_PROMPT: 'from-settings' },
      CUSTOM_KEY: 'from-settings'
    }
    settings.get = key => settings[key]
    getEnv.setSettings(settings)

    expect(getEnv('CUSTOM_KEY', 'fallback')).toBe('from-settings')
    expect(getEnv('SAMPLE_PROMPT')).toBe('from-settings')
  })
})
