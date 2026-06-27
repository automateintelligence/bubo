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

// Extract added lines from a unified diff (lines starting with a single `+`,
// excluding the `+++` file header). Strip the leading `+` so patterns match the
// raw code.
function addedLines(diffExcerpt) {
  return String(diffExcerpt || '')
    .split('\n')
    .filter((line) => /^\+(?!\+\+)/.test(line))
    .map((line) => line.slice(1))
}

// The text a content heuristic should inspect. When the excerpt looks like a
// diff we only consider added lines, so removing risky code never triggers a
// finding; when it is raw code (or has no `+` lines) we scan it whole. Tool
// output is always appended because failure signals live there.
function reviewableSource(packet) {
  const diff = String(packet.diffExcerpt || '')
  const added = addedLines(diff)
  const base = added.length ? added.join('\n') : diff
  return `${base}\n${packet.toolOutputExcerpt || ''}`
}

// Each content heuristic is { test, review }. `test` runs against the
// added/raw source; `review` is the normalized note in Bubo's voice. Order is
// priority order: security first, then correctness, then hygiene.
const CONTENT_HEURISTICS = [
  {
    id: 'sentinel-id',
    test: /\balert_id\s*[:=]\s*0\b/,
    review: {
      problem: 'placeholder alert_id=0 can collide under concurrent speculative bursts',
      evidence: 'the diff introduces a fixed sentinel before VLM resolution',
      solution: 'allocate a unique temporary client-side ID and reconcile after VLM returns',
      rendered: 'sentinel id. race bait. mint a temp id first'
    }
  },
  {
    id: 'hardcoded-secret',
    test: /(?:api[_-]?key|secret|password|passwd|token|client[_-]?secret)\s*[:=]\s*['"][^'"\s]{8,}['"]|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
    review: {
      problem: 'a credential is hardcoded into the source instead of read from the environment',
      evidence: 'the added lines embed a literal secret or private key',
      solution: 'move it to an environment variable or secret store and rotate the exposed value',
      rendered: 'hardcoded secret. bronze key in the open. pull it to env and rotate'
    }
  },
  {
    id: 'eval-injection',
    test: /\beval\s*\(|\bnew Function\s*\(|\bexec\s*\(|\bos\.system\s*\(|\bchild_process\b.*\bexec(?:Sync)?\s*\(/,
    review: {
      problem: 'evaluating or shelling out on dynamic input opens a code-execution path',
      evidence: 'the change passes runtime data into eval/exec rather than a parser or safe API',
      solution: 'parse the input or use a fixed, argument-quoted API instead of executing strings',
      rendered: 'eval on live input. gate wide open. parse, do not execute'
    }
  },
  {
    id: 'sql-injection',
    test: /(?:SELECT|INSERT|UPDATE|DELETE)\b[^\n;]*(?:"\s*\+|'\s*\+|\$\{|%\s*\()/i,
    review: {
      problem: 'a SQL statement is being built by string concatenation, which invites injection',
      evidence: 'the query interpolates a value directly into the statement text',
      solution: 'use parameterized queries or a query builder that binds values',
      rendered: 'string-built sql. injection seam. bind the parameters'
    }
  },
  {
    id: 'insecure-random',
    test: /\b(?:token|secret|password|nonce|salt|session|api[_-]?key|uuid|id)\b[^\n]*\bMath\.random\s*\(|\bMath\.random\s*\([^\n]*\b(?:token|secret|password|nonce|salt|session)\b/i,
    review: {
      problem: 'Math.random is not cryptographically secure for a security-sensitive value',
      evidence: 'the change derives a token or secret-like value from Math.random',
      solution: 'use a CSPRNG such as crypto.randomBytes or crypto.randomUUID',
      rendered: 'Math.random for a secret. guessable. reach for a csprng'
    }
  },
  {
    id: 'dangerous-shell',
    test: /\brm\s+-rf?\b|\bcurl\b[^\n]*\|\s*(?:sudo\s+)?(?:ba)?sh\b|\bgit\s+push\s+(?:-f|--force)\b/,
    review: {
      problem: 'a destructive or irreversible shell action sits in the change set',
      evidence: 'the diff adds a recursive delete, force push, or pipe-to-shell',
      solution: 'scope the target explicitly, add a guard or dry-run, and avoid piping remote input to a shell',
      rendered: 'rm -rf in the diff. one typo from ruin. scope it and guard it'
    }
  },
  {
    id: 'focused-test',
    test: /\b(?:describe|it|test|context)\.only\s*\(|\b(?:fdescribe|fit)\s*\(/,
    review: {
      problem: 'a focused test will silently skip the rest of the suite if it is committed',
      evidence: 'the change adds a .only / fdescribe / fit marker',
      solution: 'remove the focus marker before merging so the full suite runs in CI',
      rendered: 'focused test committed. green suite, blind spots. drop the only'
    }
  },
  {
    id: 'skipped-test',
    test: /\b(?:describe|it|test)\.skip\s*\(|\b(?:xit|xdescribe)\s*\(/,
    review: {
      problem: 'a skipped test quietly drops coverage and tends to stay skipped forever',
      evidence: 'the change adds a .skip / xit / xdescribe marker',
      solution: 'fix and re-enable the test, or delete it and note why the coverage is gone',
      rendered: 'test skipped. coverage quietly bled. re-enable or bury it'
    }
  },
  {
    id: 'left-in-debugger',
    test: /\bdebugger\b|\bbreakpoint\s*\(\s*\)|\bpdb\.set_trace\s*\(|\bbinding\.pry\b|\bconsole\.debug\s*\(/,
    review: {
      problem: 'a debugging breakpoint is about to ship in the change set',
      evidence: 'the diff adds a debugger / set_trace / pry statement',
      solution: 'strip the breakpoint before committing',
      rendered: 'debugger left in. trap door shipped. strip it'
    }
  },
  {
    id: 'lint-suppression',
    test: /@ts-ignore\b|@ts-nocheck\b|eslint-disable\b|#\s*type:\s*ignore\b|#\s*noqa\b|@SuppressWarnings\b|\bnolint\b|#pragma\s+warning\s+disable/i,
    review: {
      problem: 'the change silences a checker instead of resolving what it flagged',
      evidence: 'a type/lint suppression directive was added at the changed site',
      solution: 'fix the underlying issue, or scope the suppression narrowly with a reason',
      rendered: 'checker silenced. smoke over fire. fix it, do not mute it'
    }
  },
  {
    id: 'as-any',
    test: /\bas\s+any\b|\bas\s+unknown\s+as\b|:\s*any\b(?!\])/,
    review: {
      problem: 'an `any` escape hatch drops type safety at the boundary it is most needed',
      evidence: 'the change introduces an as-any / as-unknown-as cast or an any annotation',
      solution: 'narrow to a precise type or add an explicit, checked conversion at the boundary',
      rendered: 'as any. types surrendered. narrow the boundary proper'
    }
  },
  {
    id: 'swallowed-catch',
    test: /catch\s*(\([^)]*\))?\s*\{\s*\}/,
    review: {
      problem: 'an empty catch block can hide state corruption and flatten real failure signals',
      evidence: 'the current change set swallows an exception without recording or rethrowing it',
      solution: 'log the failure context or rethrow after attaching the minimum useful metadata',
      rendered: 'empty catch. bug tomb. log it or throw it'
    }
  },
  {
    id: 'fixme-marker',
    test: /\b(?:FIXME|XXX|HACK)\b/,
    review: {
      problem: 'an unfinished-work marker is shipping as part of the change',
      evidence: 'the diff adds a FIXME / XXX / HACK note',
      solution: 'close the gap now, or file a tracked issue and reference it instead of leaving a raw marker',
      rendered: 'FIXME shipped. debt with a name. close it or ticket it'
    }
  }
]

function contentReview(packet) {
  const source = reviewableSource(packet)
  for (const heuristic of CONTENT_HEURISTICS) {
    if (heuristic.test.test(source)) {
      return normalizeReview(heuristic.review)
    }
  }
  return null
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

function heuristicReview(packet, config) {
  return contentReview(packet) ||
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

module.exports = { generateReview, addedLines, reviewableSource }
