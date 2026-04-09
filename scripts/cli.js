#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const { execSync } = require('node:child_process')

const { renderReviewLine, normalizeReview } = require('./lib/render')
const { generateReview } = require('./lib/generate')
const { resolveProjectRoot } = require('./lib/project')
const { createReview, ensureProjectState, readConfig, readReviews, readState, writeState } = require('./lib/store')
const { promoteReview } = require('./lib/promote')
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

function findRecentDuplicate(reviews, normalizedReview, reason, dedupWindow) {
  const recent = reviews.slice(-dedupWindow)
  return recent.find((review) =>
    review.reason === reason &&
    review.problem === normalizedReview.problem &&
    review.evidence === normalizedReview.evidence
  ) || null
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
  const normalized = normalizeReview(generated)
  const duplicate = findRecentDuplicate(packet.recentReviews, normalized, reason, config.dedupWindow)

  if (duplicate) {
    process.stdout.write(`${renderReviewLine(duplicate)}\n`)
    return 0
  }

  const created = createReview(projectRoot, {
    reason,
    problem: normalized.problem,
    evidence: normalized.evidence,
    solution: normalized.solution,
    rendered: normalized.rendered,
    context: packet
  })

  state.lastTriggerAt = {
    ...(state.lastTriggerAt || {}),
    [reason]: now
  }
  writeState(projectRoot, state)

  process.stdout.write(`${renderReviewLine(created)}\n`)
  return 0
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

async function main(argv) {
  const { positionals, options } = parseArgs(argv)
  const command = positionals[0]

  if (command === 'review-code') {
    return runReview(options)
  }

  if (command === 'implement') {
    return runPromote(positionals, options)
  }

  throw new Error(`Unknown command: ${command}`)
}

main(process.argv.slice(2))
  .then((code) => {
    process.exit(code)
  })
  .catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  })
