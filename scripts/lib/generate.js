const { spawnSync } = require('node:child_process')
const { normalizeReview } = require('./render')

function firstMeaningfulLine(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || ''
}

function changedLineCount(diffExcerpt) {
  return String(diffExcerpt || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[+-](?![+-])/.test(line))
    .length
}

function sentinelIdReview(packet) {
  const source = `${packet.diffExcerpt}\n${packet.toolOutputExcerpt}`
  if (!/\balert_id\s*[:=]\s*0\b/.test(source)) return null

  return normalizeReview({
    problem: 'placeholder alert_id=0 can collide under concurrent speculative bursts',
    evidence: 'the diff introduces a fixed sentinel before VLM resolution',
    solution: 'allocate a unique temporary client-side ID and reconcile after VLM returns',
    rendered: 'sentinel id. race bait. mint a temp id first'
  })
}

function swallowedCatchReview(packet) {
  const source = `${packet.diffExcerpt}\n${packet.toolOutputExcerpt}`
  if (!/catch\s*(\([^)]*\))?\s*\{\s*\}/.test(source)) return null

  return normalizeReview({
    problem: 'an empty catch block can hide state corruption and flatten real failure signals',
    evidence: 'the current change set swallows an exception without recording or rethrowing it',
    solution: 'log the failure context or rethrow after attaching the minimum useful metadata',
    rendered: 'empty catch. bug tomb. log it or throw it'
  })
}

function tsIgnoreReview(packet) {
  const source = `${packet.diffExcerpt}\n${packet.toolOutputExcerpt}`
  if (!/@ts-ignore\b/.test(source)) return null

  return normalizeReview({
    problem: 'the new ts-ignore hides a type contract problem instead of resolving it',
    evidence: 'the diff suppresses the checker at the changed call site',
    solution: 'tighten the local type or add an explicit narrow conversion at the boundary',
    rendered: 'ts-ignore. type smoke. narrow the boundary proper'
  })
}

function genericFailureReview(packet) {
  const source = String(packet.toolOutputExcerpt || '').trim()
  if (!source) return null

  return normalizeReview({
    problem: 'the current change set is already failing under observed execution',
    evidence: firstMeaningfulLine(source) || 'recent tool output contains a failure signal',
    solution: 'fix the first failing assertion or exception before layering on more edits',
    rendered: 'already failing. first wound first. clear the break before more edits'
  })
}

function largeDiffReview(packet, config) {
  const count = changedLineCount(packet.diffExcerpt)
  if (count <= (config.largeDiffThreshold || 80)) return null

  return normalizeReview({
    problem: 'the wide change set raises regression risk across the touched surface',
    evidence: `the diff spans ${count} changed lines across the active working set`,
    solution: 'verify the hottest touched path now before stacking more edits on top',
    rendered: 'big diff. seam stress. verify the hot path now'
  })
}

function heuristicReview(packet, config) {
  return sentinelIdReview(packet) ||
    swallowedCatchReview(packet) ||
    tsIgnoreReview(packet) ||
    largeDiffReview(packet, config) ||
    genericFailureReview(packet) ||
    null
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
      return heuristicReview(packet, config)
    }
  }

  return heuristicReview(packet, config)
}

module.exports = { generateReview }
