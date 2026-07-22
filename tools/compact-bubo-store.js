#!/usr/bin/env node

// One-time compaction for Bubo stores bloated by the recentReviews recursion.
//
// Before the clamp landed in createReview, a review stored its full context,
// and context.recentReviews carried whole prior reviews INCLUDING their
// context, which carried their recentReviews, and so on. Each generation
// multiplied the store; one securitysight record reached 124MB and the file
// reached 366MB, which made every read (12s+ under the lock) a liability.
//
// This rewrites each record with its context bounded by the same clampContext
// the runtime now applies on write, so ids, timestamps, and the rendered note
// are untouched while the megabyte payloads are dropped. It runs under the
// store lock and keeps a backup.
//
//   node tools/compact-bubo-store.js <project-or-.bubo-path>          # dry run
//   node tools/compact-bubo-store.js <path> --write                  # apply
//
// For a very large store, give node headroom for the biggest single record:
//   node --max-old-space-size=6144 tools/compact-bubo-store.js <path> --write

const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')

const { clampContext } = require('../scripts/lib/store')
const lock = require('../scripts/lib/lock')

function resolveStore(target) {
  const buboDir = path.basename(target) === '.bubo' ? target : path.join(target, '.bubo')
  const reviews = path.join(buboDir, 'reviews.jsonl')
  return fs.existsSync(reviews) ? { buboDir, reviews } : null
}

// Stream the file so a multi-megabyte record never forces the whole store into
// memory at once. Returns the rewritten content and a size report. Damaged
// lines are passed through verbatim, never dropped.
async function compact(reviewsPath) {
  const rl = readline.createInterface({
    input: fs.createReadStream(reviewsPath),
    crlfDelay: Infinity
  })

  const outLines = []
  let before = 0
  let after = 0
  let compacted = 0
  let damaged = 0

  for await (const line of rl) {
    if (!line) continue
    before += line.length + 1

    let record
    try {
      record = JSON.parse(line)
    } catch {
      outLines.push(line)
      after += line.length + 1
      damaged += 1
      continue
    }

    const clampedContext = clampContext(record.context)
    if ('context' in record) record.context = clampedContext
    const rewritten = JSON.stringify(record)
    if (rewritten.length < line.length) compacted += 1
    outLines.push(rewritten)
    after += rewritten.length + 1
  }

  return {
    content: outLines.length ? `${outLines.join('\n')}\n` : '',
    before,
    after,
    compacted,
    damaged,
    records: outLines.length
  }
}

async function run(argv) {
  const write = argv.includes('--write')
  const target = argv.find((a) => !a.startsWith('--'))

  if (!target) {
    process.stderr.write(
      'usage: compact-bubo-store.js <project-or-.bubo-path> [--write]\n'
    )
    return 1
  }

  const store = resolveStore(target)
  if (!store) {
    process.stderr.write(`no .bubo/reviews.jsonl under ${target}\n`)
    return 1
  }

  process.stdout.write(write ? 'Compacting\n\n' : 'Dry run — nothing is written\n\n')

  // Take the same lock the runtime uses, so a live session cannot append a
  // record between our read and our replace.
  const held = write ? lock.acquire(store.buboDir) : null
  try {
    const result = await compact(store.reviews)
    const mb = (n) => (n / 1e6).toFixed(1)

    process.stdout.write(`${store.buboDir}\n`)
    process.stdout.write(
      `  ${result.records} records, ${result.compacted} shrunk` +
      (result.damaged ? `, ${result.damaged} unparseable (left verbatim)` : '') + '\n'
    )
    process.stdout.write(`  ${mb(result.before)} MB -> ${mb(result.after)} MB\n\n`)

    if (!write) {
      if (result.before !== result.after) {
        process.stdout.write('Re-run with --write to apply (a .bak is kept).\n')
      }
      return 0
    }

    if (result.before === result.after) {
      process.stdout.write('Nothing to compact.\n')
      return 0
    }

    const backup = `${store.reviews}.${new Date().toISOString().replace(/[:.]/g, '')}.precompact.bak`
    fs.copyFileSync(store.reviews, backup, fs.constants.COPYFILE_EXCL)

    const tmp = `${store.reviews}.${process.pid}.compact.tmp`
    const handle = fs.openSync(tmp, 'wx')
    try {
      fs.writeFileSync(handle, result.content)
      fs.fsyncSync(handle)
    } catch (error) {
      fs.closeSync(handle)
      fs.rmSync(tmp, { force: true })
      throw error
    }
    fs.closeSync(handle)
    fs.renameSync(tmp, store.reviews)

    process.stdout.write(`Compacted. Backup at ${path.basename(backup)}\n`)
    return 0
  } finally {
    if (held) lock.release(held)
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => process.exit(code))
}

module.exports = { compact, resolveStore }
