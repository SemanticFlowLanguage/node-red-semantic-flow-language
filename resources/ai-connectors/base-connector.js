/* eslint-disable no-unused-vars */
/*
  Base AI Connector Interface
  Defines the contract all AI connectors must implement
  Part of Semantic Flow Language - AI Integration

  Required methods:
  - getConfig(): Returns connector-specific configuration from environment
  - validateConfig(config): Validates configuration, returns { valid, errors }
  - generateFlow(prompt, context, configOverride): Generates Node-RED flow from prompt
  - resyncNode(nodeId, nodeType, info, currentConfig): Re-syncs single node logic with AI
  - buildSystemPrompt(): Returns system prompt for AI
  - buildUserPrompt(prompt, context): Returns user prompt with context
*/
const axios = require('axios')
const getEnv = require('../config-loader')
const ConnectorUtils = require('./connector-utils')

const BaseConnector = {
  name: 'base',
  getConfig() {
    throw new Error('getConfig() must be implemented by connector')
  },
  validateConfig() {
    throw new Error('validateConfig() must be implemented by connector')
  },
  async generateFlow() {
    throw new Error('generateFlow() must be implemented by connector')
  },
  async resyncNode() {
    throw new Error('resyncNode() must be implemented by connector')
  },
  buildSystemPrompt() {
    throw new Error('buildSystemPrompt() must be implemented by connector')
  },
  buildUserPrompt() {
    throw new Error('buildUserPrompt() must be implemented by connector')
  }
}

module.exports = BaseConnector
