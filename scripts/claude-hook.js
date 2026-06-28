#!/usr/bin/env node

// Bubo hook entrypoint for Claude Code. Reads a hook event as JSON on stdin
// and, when a review fires, prints a JSON object whose hookSpecificOutput
// injects the passive note as additionalContext. Stays silent (empty stdout,
// exit 0) when nothing fires, so it never disrupts the session.

const { handleHookEvent } = require('./lib/claude-hook')

function readStdin() {
  return new Promise((resolve) => {
    let data = ''
    if (process.stdin.isTTY) {
      resolve('')
      return
    }
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { data += chunk })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', () => resolve(data))
  })
}

async function main() {
  const raw = await readStdin()
  let event
  try {
    event = JSON.parse(raw || '{}')
  } catch {
    // Malformed payload: do nothing rather than break the session.
    return 0
  }

  const output = await handleHookEvent(event)
  if (output) {
    process.stdout.write(`${JSON.stringify(output)}\n`)
  }
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch(() => {
    // A failing review must never block the host session.
    process.exit(0)
  })
