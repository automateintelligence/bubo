#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const { execSync } = require('node:child_process')

const { renderReviewLine, normalizeReview } = require('./lib/render')
const { generateReview } = require('./lib/generate')
const { resolveProjectRoot } = require('./lib/project')
const { createReview, ensureProjectState, readConfig, readReviews, readState, writeState } = require('./lib/store')
const { considerReview, promoteReview } = require('./lib/promote')
const { shouldTriggerReview } = require('./lib/trigger')

function parseArgs(argv) {
  const positionals = []
  const options = {}

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }

    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      options[key] = true
      continue
    }

    options[key] = next
    index += 1
  }

  return { positionals, options }
}

function normalizeCommand(positionals) {
  const [command, ...rest] = positionals

  if (command === 'review') {
    return ['review-code', ...rest]
  }

  const considerMatch = /^consider-(\d+)$/.exec(command || '')
  if (considerMatch) {
    return ['consider', considerMatch[1], ...rest]
  }

  const implementMatch = /^implement-(\d+)$/.exec(command || '')
  if (implementMatch) {
    return ['implement', implementMatch[1], ...rest]
  }

  return positionals
}

function clamp(text, limit) {
  const value = String(text || '')
  return value.length <= limit ? value : value.slice(0, limit)
}

function readOptionalText(options, textKey, fileKey) {
  if (typeof options[textKey] === 'string') return options[textKey]
  if (typeof options[fileKey] === 'string' && fs.existsSync(options[fileKey])) {
    return fs.readFileSync(options[fileKey], 'utf8')
  }
  return ''
}

function tryGit(projectRoot, args) {
  try {
    return execSync(`git -C "${projectRoot}" ${args}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return ''
  }
}

function getChangedFiles(projectRoot) {
  const output = tryGit(projectRoot, 'diff --name-only')
  return output ? output.split('\n').filter(Boolean) : []
}

function getDiffExcerpt(projectRoot, options) {
  const explicit = readOptionalText(options, 'diff-text', 'diff-file')
  if (explicit) return clamp(explicit, 5000)
  return clamp(tryGit(projectRoot, 'diff --no-ext-diff'), 5000)
}

function getToolOutputExcerpt(options) {
  return clamp(readOptionalText(options, 'tool-output-text', 'tool-output-file'), 5000)
}

function getRecentTurns(options) {
  const explicit = readOptionalText(options, 'turns-text', 'turns-file')
  if (!explicit) return []

  return explicit
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-12)
    .map((line) => ({ role: 'context', text: line }))
}

function persistReview(projectRoot, state, reason, normalized, context) {
  const created = createReview(projectRoot, {
    reason,
    problem: normalized.problem,
    evidence: normalized.evidence,
    solution: normalized.solution,
    rendered: normalized.rendered,
    context
  })

  const nextState = readState(projectRoot)
  nextState.lastTriggerAt = {
    ...(nextState.lastTriggerAt || {}),
    [reason]: Date.now()
  }
  writeState(projectRoot, nextState)

  process.stdout.write(`${renderReviewLine(created)}\n`)
  return 0
}

async function runReview(options) {
  const projectRoot = resolveProjectRoot(options.project || process.cwd())
  ensureProjectState(projectRoot)

  const reason = options.reason || 'manual'
  const config = readConfig(projectRoot)
  const state = readState(projectRoot)
  const now = Date.now()
  const decision = shouldTriggerReview({ reason, now, state, config })

  if (!decision.allowed) {
    process.stdout.write(`No review emitted: cooldown active for ${reason}.\n`)
    return 0
  }

  const packet = {
    reason,
    cwd: projectRoot,
    timestamp: new Date(now).toISOString(),
    recentTurns: getRecentTurns(options),
    toolOutputExcerpt: getToolOutputExcerpt(options),
    changedFiles: getChangedFiles(projectRoot),
    diffExcerpt: getDiffExcerpt(projectRoot, options),
    recentReviews: readReviews(projectRoot).slice(-config.dedupWindow)
  }

  const generated = await generateReview(packet, config)
  if (!generated) {
    process.stdout.write('No review emitted: no concrete improvement found.\n')
    return 0
  }

  const normalized = normalizeReview(generated)

  return persistReview(projectRoot, state, reason, normalized, packet)
}

function runSession(positionals, options) {
  const action = positionals[1]
  const projectRoot = resolveProjectRoot(options.project || process.cwd())
  ensureProjectState(projectRoot)
  const state = readState(projectRoot)

  if (action === 'start') {
    state.enabled = true
    writeState(projectRoot, state)
    process.stdout.write('Bubo session enabled.\n')
    return 0
  }

  if (action === 'stop') {
    state.enabled = false
    writeState(projectRoot, state)
    process.stdout.write('Bubo session disabled.\n')
    return 0
  }

  if (action === 'status') {
    process.stdout.write(`Bubo session is ${state.enabled === false ? 'disabled' : 'enabled'}.\n`)
    return 0
  }

  throw new Error('Usage: bubo session <start|stop|status>')
}

function runPromote(positionals, options) {
  const id = positionals[1]
  if (!id) {
    throw new Error('Usage: bubo implement <id>')
  }

  const projectRoot = resolveProjectRoot(options.project || process.cwd())
  ensureProjectState(projectRoot)
  const promoted = promoteReview(projectRoot, id)
  process.stdout.write(`${promoted.taskPrompt}\n`)
  return 0
}

function runConsider(positionals, options) {
  const id = positionals[1]
  if (!id) {
    throw new Error('Usage: bubo consider <id>')
  }

  const projectRoot = resolveProjectRoot(options.project || process.cwd())
  ensureProjectState(projectRoot)
  const considered = considerReview(projectRoot, id)
  process.stdout.write(`${considered.taskPrompt}\n`)
  return 0
}

function runRecord(options) {
  const projectRoot = resolveProjectRoot(options.project || process.cwd())
  ensureProjectState(projectRoot)
  const reason = options.reason || 'turn'
  const state = readState(projectRoot)

  if (state.enabled === false) {
    throw new Error('Bubo session is disabled')
  }

  const normalized = normalizeReview({
    problem: options.problem || '',
    evidence: options.evidence || '',
    solution: options.solution || '',
    rendered: options.rendered || ''
  })

  if (!normalized.problem || !normalized.evidence || !normalized.solution) {
    throw new Error('record-review requires --problem, --evidence, and --solution')
  }

  return persistReview(projectRoot, state, reason, normalized, {
    source: 'record-review',
    timestamp: new Date().toISOString()
  })
}

async function main(argv) {
  const parsed = parseArgs(argv)
  const positionals = normalizeCommand(parsed.positionals)
  const { options } = parsed
  const command = positionals[0]

  if (command === 'review-code') {
    return runReview(options)
  }

  if (command === 'consider') {
    return runConsider(positionals, options)
  }

  if (command === 'implement') {
    return runPromote(positionals, options)
  }

  if (command === 'record-review') {
    return runRecord(options)
  }

  if (command === 'session') {
    return runSession(positionals, options)
  }

  throw new Error(`Unknown command: ${command}`)
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exit(code)
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`)
      process.exit(1)
    })
}

module.exports = { main, normalizeCommand, parseArgs }
