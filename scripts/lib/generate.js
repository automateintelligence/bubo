const { spawnSync } = require('node:child_process')
const { normalizeReview } = require('./render')

function firstMeaningfulLine(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || ''
}

function sentinelIdReview(packet) {
  const source = `${packet.diffExcerpt}\n${packet.toolOutputExcerpt}`
  if (!/\balert_id\s*[:=]\s*0\b/.test(source)) return null

  return normalizeReview({
    problem: 'placeholder alert_id=0 can collide under concurrent speculative bursts',
    evidence: 'the diff introduces a fixed sentinel before VLM resolution',
    solution: 'allocate a unique temporary client-side ID and reconcile after VLM returns'
  })
}

function swallowedCatchReview(packet) {
  const source = `${packet.diffExcerpt}\n${packet.toolOutputExcerpt}`
  if (!/catch\s*(\([^)]*\))?\s*\{\s*\}/.test(source)) return null

  return normalizeReview({
    problem: 'an empty catch block can hide state corruption and flatten real failure signals',
    evidence: 'the current change set swallows an exception without recording or rethrowing it',
    solution: 'log the failure context or rethrow after attaching the minimum useful metadata'
  })
}

function tsIgnoreReview(packet) {
  const source = `${packet.diffExcerpt}\n${packet.toolOutputExcerpt}`
  if (!/@ts-ignore\b/.test(source)) return null

  return normalizeReview({
    problem: 'the new ts-ignore hides a type contract problem instead of resolving it',
    evidence: 'the diff suppresses the checker at the changed call site',
    solution: 'tighten the local type or add an explicit narrow conversion at the boundary'
  })
}

function genericFailureReview(packet) {
  const source = String(packet.toolOutputExcerpt || '').trim()
  if (!source) return null

  return normalizeReview({
    problem: 'the current change set is already failing under observed execution',
    evidence: firstMeaningfulLine(source) || 'recent tool output contains a failure signal',
    solution: 'fix the first failing assertion or exception before layering on more edits'
  })
}

function genericDiffReview(packet) {
  const changed = packet.changedFiles && packet.changedFiles.length
    ? packet.changedFiles.join(', ')
    : 'the current working set'

  return normalizeReview({
    problem: 'the latest change set may be harder to validate than it looks',
    evidence: `recent changes touch ${changed}`,
    solution: 'run a focused verification pass on the highest-risk changed path before continuing'
  })
}

function heuristicReview(packet) {
  return sentinelIdReview(packet) ||
    swallowedCatchReview(packet) ||
    tsIgnoreReview(packet) ||
    genericFailureReview(packet) ||
    genericDiffReview(packet)
}

function commandReview(packet, provider) {
  const result = spawnSync(provider.command, provider.args || [], {
    input: JSON.stringify(packet),
    encoding: 'utf8'
  })

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `review command failed with ${result.status}`)
  }

  return normalizeReview(JSON.parse(result.stdout))
}

async function generateReview(packet, config) {
  const provider = config.provider || { kind: 'heuristic' }

  if (provider.kind === 'command' && provider.command) {
    try {
      return commandReview(packet, provider)
    } catch {
      return heuristicReview(packet)
    }
  }

  return heuristicReview(packet)
}

module.exports = { generateReview }
