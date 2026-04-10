const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_CONFIG = {
  cooldowns: {
    turnMs: 10000,
    signalMs: 5000
  },
  dedupWindow: 5,
  largeDiffThreshold: 80,
  provider: {
    kind: 'heuristic'
  }
}

const DEFAULT_STATE = {
  nextId: 1,
  lastTriggerAt: {},
  dedup: [],
  enabled: true
}

function buboDir(root) {
  return path.join(root, '.bubo')
}

function ensureFile(filePath, initialValue) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, initialValue)
  }
}

function ensureProjectState(root) {
  const dir = buboDir(root)
  fs.mkdirSync(dir, { recursive: true })

  ensureFile(path.join(dir, 'state.json'), JSON.stringify(DEFAULT_STATE, null, 2) + '\n')

  ensureFile(path.join(dir, 'config.json'), JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n')
  ensureFile(path.join(dir, 'reviews.jsonl'), '')
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

function readConfig(root) {
  ensureProjectState(root)
  const config = readJsonFile(path.join(buboDir(root), 'config.json'), DEFAULT_CONFIG)

  return {
    ...DEFAULT_CONFIG,
    ...config,
    cooldowns: {
      ...DEFAULT_CONFIG.cooldowns,
      ...(config.cooldowns || {})
    },
    provider: {
      ...DEFAULT_CONFIG.provider,
      ...(config.provider || {})
    }
  }
}

function readState(root) {
  ensureProjectState(root)
  return {
    ...DEFAULT_STATE,
    ...readJsonFile(path.join(buboDir(root), 'state.json'), DEFAULT_STATE)
  }
}

function writeState(root, state) {
  ensureProjectState(root)
  fs.writeFileSync(path.join(buboDir(root), 'state.json'), JSON.stringify(state, null, 2) + '\n')
}

function appendReview(root, review) {
  ensureProjectState(root)
  fs.appendFileSync(path.join(buboDir(root), 'reviews.jsonl'), JSON.stringify(review) + '\n')
}

function readReviews(root) {
  ensureProjectState(root)
  const file = path.join(buboDir(root), 'reviews.jsonl')
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function rewriteReviews(root, reviews) {
  ensureProjectState(root)
  const file = path.join(buboDir(root), 'reviews.jsonl')
  const payload = reviews.map((review) => JSON.stringify(review)).join('\n')
  fs.writeFileSync(file, payload ? `${payload}\n` : '')
}

function createReview(root, payload) {
  ensureProjectState(root)
  const state = readState(root)
  const review = {
    id: state.nextId,
    timestamp: new Date().toISOString(),
    status: payload.status || 'new',
    ...payload
  }

  state.nextId += 1
  writeState(root, state)
  appendReview(root, review)
  return review
}

module.exports = {
  DEFAULT_CONFIG,
  DEFAULT_STATE,
  appendReview,
  buboDir,
  createReview,
  ensureProjectState,
  readConfig,
  readReviews,
  readState,
  rewriteReviews,
  writeState
}
