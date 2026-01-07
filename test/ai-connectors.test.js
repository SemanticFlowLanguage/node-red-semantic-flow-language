const axios = require('axios')

jest.mock('axios', () => ({
  post: jest.fn()
}))

describe('AI connector helpers', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    jest.resetModules()
    axios.post.mockResolvedValue({
      data: {
        choices: [{ message: { content: '{"flow":[]}' } }],
        usage: {},
        model: 'test-model'
      }
    })
    process.env = {
      ...originalEnv,
      AI_API_KEY: 'key',
      AI_ENDPOINT: 'https://example.com',
      AI_DEPLOYMENT_NAME: 'deploy',
      AI_MODEL: 'gpt-4o-mini',
      AI_MAX_FLOW_CONTEXT_CHARS: '40'
    }
  })

  afterAll(() => {
    process.env = originalEnv
  })

  describe('OpenAI connector', () => {
    test('handles token setting and flow truncation helpers', () => {
      // eslint-disable-next-line global-require
      const connector = require('../resources/ai-connectors/openai-connector-node')
      const body = {}
      connector.addTokens({ model: 'gpt-4o', maxCompletionTokens: 321 }, body)
      expect(body.max_completion_tokens).toBe(321)

      const longNodes = [{ id: '1', name: 'a'.repeat(50) }, { id: '2', name: 'b' }]
      const serialized = connector.serializeFlowContext(longNodes)
      expect(serialized).toContain('Flow truncated')
    })

    test('buildUserPrompt injects context', () => {
      // eslint-disable-next-line global-require
      const connector = require('../resources/ai-connectors/openai-connector-node')
      const prompt = connector.buildUserPrompt('do something', { nodes: [{ id: 'n1' }] })
      expect(prompt).toContain('"id": "n1"')
    })
  })

  describe('Azure OpenAI connector', () => {
    test('validates required config and applies max tokens', () => {
      // eslint-disable-next-line global-require
      const connector = require('../resources/ai-connectors/azure-openai-connector-node')
      const invalid = connector.validateConfig({ endpoint: '', apiKey: '', deploymentName: '' })
      expect(invalid.valid).toBe(false)

      const body = {}
      connector.addTokens({ maxCompletionTokens: 50 }, body)
      expect(body.max_completion_tokens).toBe(50)
    })
  })

  describe('Google connector', () => {
    test('sets placeholder values and maxOutputTokens', () => {
      // eslint-disable-next-line global-require
      const connector = require('../resources/ai-connectors/google-connector-node')
      const rendered = connector.setPlaceholders('Hello {name}', { name: 'World' })
      expect(rendered).toBe('Hello World')

      const config = { maxTokens: 10 }
      const generationConfig = {}
      connector.addTokens(config, generationConfig)
      expect(generationConfig.maxOutputTokens).toBe(10)
    })
  })

  describe('Anthropic connector', () => {
    test('applies fallback max tokens and context serialization', () => {
      // eslint-disable-next-line global-require
      const connector = require('../resources/ai-connectors/anthropic-connector-node')
      const body = {}
      connector.addTokens({}, body, 25)
      expect(body.max_tokens).toBe(25)

      const serialized = connector.serializeFlowContext([{ id: '1' }, { id: '2' }])
      expect(serialized).toContain('Flow truncated')
    })
  })
})
