#!/usr/bin/env node

const { spawnSync } = require('node:child_process')

const { resolveProjectRoot } = require('./lib/project')
const { ensureProjectState, readReviews } = require('./lib/store')
const { buildStartupPrompt, createStartReview } = require('./lib/session')

function parseArgs(argv) {
  const options = {
    forwardedArgs: []
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]

    if (token === '--') {
      options.forwardedArgs.push(...argv.slice(index + 1))
      break
    }

    if (!token.startsWith('--')) {
      options.forwardedArgs.push(token)
      continue
    }

    const key = token.slice(2)
    const next = argv[index + 1]

    if (['project', 'reason', 'diff-text', 'tool-output-text', 'prompt'].includes(key)) {
      options[key] = next || ''
      index += 1
      continue
    }

    if (key === 'no-review' || key === 'dry-run') {
      options[key] = true
      continue
    }

    options.forwardedArgs.push(token)
    if (next && !next.startsWith('--')) {
      options.forwardedArgs.push(next)
      index += 1
    }
  }

  return options
}

// Claude Code takes its working directory from the process cwd (no `-C` flag),
// and Bubo's startup context rides in via --append-system-prompt so it stays
// out of the visible conversation. Any explicit user prompt is the trailing
// positional argument.
function buildLaunchSpec({ projectRoot, review, forwardedArgs = [], prompt }) {
  const args = [...forwardedArgs, '--append-system-prompt', buildStartupPrompt({ review, host: 'claude' })]
  if (prompt) {
    args.push(prompt)
  }

  return {
    command: 'claude',
    cwd: projectRoot,
    args
  }
}

async function main(argv) {
  const options = parseArgs(argv)
  const projectRoot = resolveProjectRoot(options.project || process.cwd())

  let review = null
  if (!options['no-review']) {
    review = await createStartReview(projectRoot, options)
  } else {
    ensureProjectState(projectRoot)
    review = readReviews(projectRoot).at(-1) || null
  }

  const spec = buildLaunchSpec({
    projectRoot,
    review,
    forwardedArgs: options.forwardedArgs,
    prompt: options.prompt
  })

  if (options['dry-run']) {
    process.stdout.write(`${JSON.stringify(spec, null, 2)}\n`)
    return 0
  }

  const result = spawnSync(spec.command, spec.args, { stdio: 'inherit', cwd: spec.cwd })
  return result.status || 0
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`)
      process.exit(1)
    })
}

module.exports = { buildLaunchSpec, parseArgs }
