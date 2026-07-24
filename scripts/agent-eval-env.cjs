const { existsSync, readFileSync, statSync } = require('node:fs')
const { join } = require('node:path')

const LOCAL_ENV_PATH = join(__dirname, '..', '.env.agent-eval.local')
const ALLOWED_KEYS = new Set([
  'SIDEKICK_AGENT_EVAL_API_KEY',
  'SIDEKICK_AGENT_EVAL_MODEL',
  'SIDEKICK_AGENT_EVAL_PROVIDER_KIND',
  'SIDEKICK_AGENT_EVAL_REPORT',
  'SIDEKICK_AGENT_EVAL_SUITE',
  'SIDEKICK_AGENT_EVAL_TARGET',
  'SIDEKICK_AGENT_EVAL_URL',
  'SIDEKICK_LLM_EVAL_API_KEY',
  'SIDEKICK_LLM_EVAL_MODEL',
  'SIDEKICK_LLM_EVAL_URL',
  'SIDEKICK_OPENROUTER_EVAL_API_KEY',
  'SIDEKICK_OPENROUTER_EVAL_MODEL',
  'SIDEKICK_OPENROUTER_EVAL_REPORT'
])

function unquote(value) {
  if (value.length < 2) return value
  const first = value[0]
  const last = value.at(-1)
  return (first === '"' && last === '"') || (first === "'" && last === "'")
    ? value.slice(1, -1)
    : value
}

function parseLocalEnvironment(contents, source = '.env.agent-eval.local') {
  const values = new Map()
  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line
    const separator = normalized.indexOf('=')
    if (separator < 1) throw new Error(`${source}:${index + 1} must use NAME=value syntax`)
    const key = normalized.slice(0, separator).trim()
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`${source}:${index + 1} contains unsupported variable ${key}`)
    }
    const value = unquote(normalized.slice(separator + 1).trim())
    if (value.includes('\0')) throw new Error(`${source}:${index + 1} contains an invalid value`)
    values.set(key, value)
  }
  return values
}

function loadAgentEvalEnvironment(options = {}) {
  const env = options.env || process.env
  const path = options.path || LOCAL_ENV_PATH
  if (!existsSync(path)) return { loaded: false, path, added: [], permissionsTooOpen: false }
  const stat = statSync(path)
  if (!stat.isFile()) throw new Error(`${path} must be a regular file`)
  const values = parseLocalEnvironment(readFileSync(path, 'utf8'), path)
  const added = []
  for (const [key, value] of values) {
    if (String(env[key] || '').trim()) continue
    env[key] = value
    if (value.trim()) added.push(key)
  }
  return {
    loaded: true,
    path,
    added,
    permissionsTooOpen: process.platform !== 'win32' && (stat.mode & 0o077) !== 0
  }
}

function trimmed(env, name) {
  return typeof env[name] === 'string' ? env[name].trim() : ''
}

function resolveAgentEvalEnvironment(env = process.env) {
  const genericKey = trimmed(env, 'SIDEKICK_AGENT_EVAL_API_KEY')
  const liteLlmKey = trimmed(env, 'SIDEKICK_LLM_EVAL_API_KEY')
  const openRouterKey = trimmed(env, 'SIDEKICK_OPENROUTER_EVAL_API_KEY')
  const explicitKind = trimmed(env, 'SIDEKICK_AGENT_EVAL_PROVIDER_KIND')
  const providerKind =
    explicitKind || (!genericKey && !liteLlmKey && openRouterKey ? 'openrouter' : 'litellm')
  const usesOpenRouter = providerKind === 'openrouter'
  const providerKey = usesOpenRouter ? openRouterKey : liteLlmKey
  const apiKey = genericKey || providerKey
  const credentialSource = genericKey
    ? 'SIDEKICK_AGENT_EVAL_API_KEY'
    : providerKey
      ? usesOpenRouter
        ? 'SIDEKICK_OPENROUTER_EVAL_API_KEY'
        : 'SIDEKICK_LLM_EVAL_API_KEY'
      : null
  return {
    apiKey,
    credentialSource,
    providerKind,
    url:
      trimmed(env, 'SIDEKICK_AGENT_EVAL_URL') ||
      (usesOpenRouter
        ? 'https://openrouter.ai/api/v1'
        : trimmed(env, 'SIDEKICK_LLM_EVAL_URL') || 'http://127.0.0.1:1234/v1'),
    model:
      trimmed(env, 'SIDEKICK_AGENT_EVAL_MODEL') ||
      (usesOpenRouter
        ? trimmed(env, 'SIDEKICK_OPENROUTER_EVAL_MODEL') || 'poolside/laguna-s-2.1:free'
        : trimmed(env, 'SIDEKICK_LLM_EVAL_MODEL') || 'local-loaded-model')
  }
}

function warnAboutLocalEnvironment(result) {
  if (result.permissionsTooOpen) {
    console.warn(
      `[agent-eval] ${result.path} is readable by other local users; run chmod 600 on it.`
    )
  }
}

module.exports = {
  ALLOWED_KEYS,
  LOCAL_ENV_PATH,
  loadAgentEvalEnvironment,
  parseLocalEnvironment,
  resolveAgentEvalEnvironment,
  warnAboutLocalEnvironment
}
