// Fixture connector for index.test.js — exercises the AI_CONNECTOR_MODULE
// loader path in index.js without needing to publish a real npm module.
module.exports = {
  __fixture: true,
  getConfig: () => ({ apiKey: 'fixture' }),
  validateConfig: () => ({ valid: true, errors: [] }),
  generateFlow: async () => ({ success: true, flow: [{ id: 'from-fixture' }] }),
  resyncNode: async () => ({ success: true, updatedNode: {} }),
  generateDescription: async () => ({ success: true, name: 'x', description: 'y' })
}
