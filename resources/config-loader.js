const fs = require('fs')
const path = require('path')
const os = require('os')
const dotenv = require('dotenv')
const prompts = require('./ai-prompts.json')

let envLoaded = false
let redSettings = null

const getSettings = key => {
  if (redSettings) {
    return typeof redSettings.get === 'function'
      ? redSettings.get(key)
      : redSettings[key]
  }

  return null
}

const loadEnv = () => {
  if (envLoaded) {
    return
  }

  const envCandidates = [
    path.join(os.homedir(), '.node-red', '.env'),
    path.join(__dirname, '..', '.env'),
    path.join(process.cwd(), '.env')
  ]
  const envPath = envCandidates.find(fs.existsSync)

  if (envPath) {
    dotenv.config({ path: envPath })
  } else {
    dotenv.config()
  }

  const settingsPrompts = getSettings('aiPrompts') || {}

  // pull prompts from settings file and override any existing prompts
  process.env = { ...process.env, ...prompts, ...settingsPrompts }
  envLoaded = true
}

module.exports = (key, fallback = '') => {
  loadEnv()

  return getSettings(key) || process.env[key] || fallback
}

module.exports.setSettings = settings => {
  redSettings = settings
}
