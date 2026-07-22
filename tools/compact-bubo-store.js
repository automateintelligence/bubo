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

// Decide the output form of one line. A line is rewritten only when it is a
// plain-object record with a safe integer id — otherwise it is passed through
// byte-for-byte:
//   * non-object JSON (null, numbers, strings) is structurally not a record;
//   * an unsafe-integer id cannot survive JSON.parse/stringify (9007199254740993
//     rounds to ...992), so reserializing it would silently change the id.
function transformLine(line) {
  let record
  try {
    record = JSON.parse(line)
  } catch {
    return { out: line, kind: 'damaged' }
  }

  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { out: line, kind: 'damaged' }
  }

  if (!Number.isSafeInteger(record.id)) {
    return { out: line, kind: 'unsafeId' }
  }

  if (!('context' in record)) {
    return { out: line, kind: 'unchanged' }
  }

  record.context = clampContext(record.context)
  const rewritten = JSON.stringify(record)
  return { out: rewritten, kind: rewritten.length < line.length ? 'compacted' : 'unchanged' }
}

// Stream input and, when `sink` is given, stream transformed output straight to
// it — so neither the whole store nor a full rewritten copy is ever held in
// memory. Only counters accumulate. A single oversized record still costs one
// line's worth of memory, which is unavoidable when it must be parsed.
async function compact(reviewsPath, sink = null) {
  const rl = readline.createInterface({
    input: fs.createReadStream(reviewsPath),
    crlfDelay: Infinity
  })

  const counts = { before: 0, after: 0, compacted: 0, damaged: 0, unsafeId: 0, records: 0 }

  for await (const line of rl) {
    if (!line) continue
    counts.before += Buffer.byteLength(line) + 1
    counts.records += 1

    const { out, kind } = transformLine(line)
    if (kind === 'damaged') counts.damaged += 1
    if (kind === 'unsafeId') counts.unsafeId += 1
    if (kind === 'compacted') counts.compacted += 1

    counts.after += Buffer.byteLength(out) + 1
    if (sink) sink(`${out}\n`)
  }

  return counts
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

  const mb = (n) => (n / 1e6).toFixed(1)
  const report = (result) => {
    process.stdout.write(`${store.buboDir}\n`)
    process.stdout.write(
      `  ${result.records} records, ${result.compacted} shrunk` +
      (result.damaged ? `, ${result.damaged} unparseable (left verbatim)` : '') +
      (result.unsafeId ? `, ${result.unsafeId} with unsafe ids (left verbatim)` : '') + '\n'
    )
    process.stdout.write(`  ${mb(result.before)} MB -> ${mb(result.after)} MB\n\n`)
  }

  if (!write) {
    process.stdout.write('Dry run — nothing is written\n\n')
    const result = await compact(store.reviews)
    report(result)
    if (result.before !== result.after) {
      process.stdout.write('Re-run with --write to apply (a .bak is kept).\n')
    }
    return 0
  }

  process.stdout.write('Compacting\n\n')
  // Take the same lock the runtime uses, so a live session cannot append a
  // record between our read and our replace. The timeout is overridable so a
  // wedged store can be waited on longer, or a test can wait less.
  const timeoutMs = Number(process.env.BUBO_LOCK_TIMEOUT_MS) || undefined
  const held = lock.acquire(store.buboDir, { timeoutMs })
  const backup = `${store.reviews}.${new Date().toISOString().replace(/[:.]/g, '')}.precompact.bak`
  const tmp = `${store.reviews}.${process.pid}.compact.tmp`

  try {
    // Back up the (still unmodified) original, then stream the transform into a
    // fresh temp file. Output is written line by line, never accumulated, so a
    // damaged or oversized record cannot force a second store-sized allocation.
    fs.copyFileSync(store.reviews, backup, fs.constants.COPYFILE_EXCL)

    const fd = fs.openSync(tmp, 'wx')
    let result
    try {
      result = await compact(store.reviews, (chunk) => fs.writeSync(fd, chunk))
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }

    report(result)

    if (result.before === result.after) {
      fs.rmSync(tmp, { force: true })
      fs.rmSync(backup, { force: true })
      process.stdout.write('Nothing to compact.\n')
      return 0
    }

    fs.renameSync(tmp, store.reviews)
    fsyncDir(store.buboDir)
    process.stdout.write(`Compacted. Backup at ${path.basename(backup)}\n`)
    return 0
  } catch (error) {
    fs.rmSync(tmp, { force: true })
    throw error
  } finally {
    lock.release(held)
  }
}

// Best-effort durability for the rename itself. Opening a directory read-only
// and fsyncing it is supported on Linux; platforms that reject it just skip.
function fsyncDir(dir) {
  let fd
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch {
    // Directory fsync unsupported here; the file fsync above still applies.
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => process.exit(code))
}

module.exports = { compact, resolveStore }
