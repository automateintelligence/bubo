#!/usr/bin/env node

// Standalone repair for Bubo stores that contain reused review ids.
//
// Deriving ids from a counter in state.json let the counter rewind (silently,
// on any unreadable state file) while reviews.jsonl kept appending, so one id
// can own several records. `implement <id>` then resolves to whichever record
// came first — usually a long-stale note.
//
// This script reassigns ids so every record is uniquely addressable again.
// It is not a plugin subcommand — run it directly — but it is NOT copyable on
// its own: it shares ../scripts/lib/lock.js with the runtime, because two
// implementations of one lock protocol drifted into evicting each other. Keep
// it alongside the repo checkout.
//
//   node tools/repair-bubo-ids.js <project-or-.bubo-path>...   # dry run
//   node tools/repair-bubo-ids.js --scan ~/programming          # find stores
//   node tools/repair-bubo-ids.js <path> --write                # apply
//
// Repair policy: in each duplicated id group the FIRST RECORD IN FILE ORDER
// keeps the id, because Array.find() is what the old lookup used and it returns
// the first physical match — so any reference written down elsewhere still
// points at the same note. Later duplicates are reassigned above the store's
// high-water mark, oldest first. Unparseable lines are preserved verbatim and
// reported, never dropped.
//
// Repair runs under the store's .bubo/.lock, so it cannot race a live session.

const fs = require('node:fs')
const path = require('node:path')

// An id is only usable if `implement <id>` can address it: a positive safe
// integer. Anything else — missing, a string, null, zero, negative, beyond the
// safe range — leaves the record permanently unreachable and must be reassigned.
function hasUsableId(review) {
  return Number.isSafeInteger(review.id) && review.id > 0
}

// Every line is retained with its original index, including blank ones, so the
// file can be rebuilt byte-for-byte apart from the ids that actually change.
function parseStore(raw) {
  const records = []
  const damaged = []
  const blanks = []

  const lines = raw.split('\n')
  // A trailing newline yields a final empty element that is not a real line.
  if (lines.length && lines[lines.length - 1] === '') lines.pop()

  lines.forEach((line, index) => {
    if (!line.trim()) {
      blanks.push({ line, index })
      return
    }

    let review
    try {
      review = JSON.parse(line)
    } catch {
      damaged.push({ line, index })
      return
    }
    // `null`, numbers and strings are all valid JSON but not reviews. Treating
    // them as records crashed later on `.id`, contradicting the promise that
    // unreadable lines are preserved rather than fatal.
    if (!review || typeof review !== 'object' || Array.isArray(review)) {
      damaged.push({ line, index })
      return
    }
    records.push({ review, line, index })
  })

  return { records, damaged, blanks }
}

// Timestamp first so reassignment follows real chronology; file order breaks
// ties. Compare the fields explicitly: relational operators on arrays coerce to
// strings, which ordered index 10 before index 2.
function compareEntries(a, b) {
  const ta = String(a.review.timestamp || '')
  const tb = String(b.review.timestamp || '')
  if (ta !== tb) return ta < tb ? -1 : 1
  return a.index - b.index
}

function planRepair(raw) {
  const { records, damaged, blanks } = parseStore(raw)

  const usable = records.filter((entry) => hasUsableId(entry.review))
  const unusable = records.filter((entry) => !hasUsableId(entry.review))

  const groups = new Map()
  usable.forEach((entry) => {
    const id = entry.review.id
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(entry)
  })

  // reduce, not Math.max(...ids): spreading a large store exceeds the argument
  // limit and throws RangeError (reproducible at 150k records).
  let nextId = records.reduce(
    (max, entry) => (hasUsableId(entry.review) && entry.review.id > max ? entry.review.id : max),
    0
  ) + 1

  const reassignments = []

  // Records whose id could never be addressed get a real one regardless of
  // whether they collide with anything.
  unusable.sort(compareEntries).forEach((entry) => {
    if (nextId > Number.MAX_SAFE_INTEGER) {
      throw new Error('Cannot repair: reassignment would exceed the safe integer ceiling')
    }
    reassignments.push({ from: entry.review.id, to: nextId, entry })
    nextId += 1
  })

  Array.from(groups.entries())
    .filter(([, entries]) => entries.length > 1)
    .sort((a, b) => (a[0] > b[0] ? 1 : -1))
    .forEach(([id, entries]) => {
      // The keeper is the FIRST RECORD IN FILE ORDER, because that is the one
      // the old Array.find() lookup resolved to. Picking by timestamp instead
      // silently moved an id to a different note whenever a store's file order
      // and timestamp order disagreed.
      const keeper = entries.reduce((lowest, entry) => (entry.index < lowest.index ? entry : lowest))
      // Everything else is reassigned oldest-first for a readable result.
      entries
        .filter((entry) => entry !== keeper)
        .sort(compareEntries)
        .forEach((entry) => {
          if (nextId > Number.MAX_SAFE_INTEGER) {
            throw new Error('Cannot repair: reassignment would exceed the safe integer ceiling')
          }
          reassignments.push({ from: id, to: nextId, entry })
          nextId += 1
        })
    })

  return { records, damaged, blanks, reassignments, nextId, duplicateIds:
    Array.from(groups.values()).filter((entries) => entries.length > 1).length }
}

// Repair is a minimal edit: only the lines whose id actually changes are
// reserialized. Everything else — untouched records, damaged lines, blank
// lines — is written back exactly as it was read, so a store comes out
// byte-identical apart from the ids that had to move.
function applyRepair(raw) {
  const plan = planRepair(raw)
  const newIdByIndex = new Map(plan.reassignments.map((r) => [r.entry.index, r.to]))

  const all = [
    ...plan.records.map((entry) => ({ index: entry.index, entry, kind: 'record' })),
    ...plan.damaged.map((entry) => ({ index: entry.index, entry, kind: 'verbatim' })),
    ...plan.blanks.map((entry) => ({ index: entry.index, entry, kind: 'verbatim' }))
  ].sort((a, b) => a.index - b.index)

  const lines = all.map((item) => {
    if (item.kind === 'verbatim') return item.entry.line
    const replacement = newIdByIndex.get(item.entry.index)
    if (!replacement) return item.entry.line
    return JSON.stringify({ ...item.entry.review, id: replacement })
  })

  // Preserve the input's own trailing-newline convention: appending one
  // unconditionally makes a non-newline-terminated store non-verbatim.
  const trailing = raw.endsWith('\n') || raw === '' ? '\n' : ''
  return { plan, content: lines.length ? `${lines.join('\n')}${trailing}` : '' }
}

// state.json is deliberately NOT touched. Its nextId is vestigial — allocation
// reads reviews.jsonl — and rewriting it here would race session and cooldown
// writers, which take no lock at all, silently discarding an explicit bubo
// stop or a cooldown update.

function resolveStore(target) {
  const asBubo = path.basename(target) === '.bubo' ? target : path.join(target, '.bubo')
  const reviews = path.join(asBubo, 'reviews.jsonl')
  return fs.existsSync(reviews) ? { dir: asBubo, reviews } : null
}

function findStores(root, depth = 4) {
  const found = []
  const walk = (dir, level) => {
    if (level > depth) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.filter((e) => e.isDirectory()).forEach((e) => {
      if (e.name === '.bubo') {
        const store = resolveStore(path.join(dir, e.name))
        if (store) found.push(store)
        return
      }
      if (e.name === 'node_modules' || e.name === '.git') return
      walk(path.join(dir, e.name), level + 1)
    })
  }
  walk(path.resolve(root), 0)
  return found
}

// The lock protocol is shared with the runtime rather than reimplemented here:
// two copies drifted apart once already (token-only owners and age-based
// eviction on this side, `token pid` owners and liveness on the other), so each
// would evict the other mid-write. This does mean the tool needs the repo
// checkout alongside it; it is still not a plugin subcommand.
const lock = require('../scripts/lib/lock')

// Refuse to work through a symlink. The store and its backup are predictable
// paths; following a link would let a planted symlink redirect the backup write
// on top of an unrelated file.
function assertNotSymlink(target) {
  let stat
  try {
    stat = fs.lstatSync(target)
  } catch {
    return
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to operate on a symlinked path: ${target}`)
  }
}

function repairStore(store, write, options = {}) {
  assertNotSymlink(store.reviews)
  const raw = fs.readFileSync(store.reviews, 'utf8')
  const { plan, content } = applyRepair(raw)

  const summary = {
    dir: store.dir,
    records: plan.records.length,
    damaged: plan.damaged.length,
    distinctIds: new Set(plan.records.map((entry) => entry.review.id)).size,
    duplicateIds: plan.duplicateIds,
    reassigned: plan.reassignments.length
  }

  if (!write || !plan.reassignments.length) return summary

  // Hold the store lock across the whole transaction: re-read under the lock so
  // a review appended between the dry-run read and now is included rather than
  // overwritten, then back up and replace.
  const held = lock.acquire(store.dir, { timeoutMs: options.lockTimeoutMs })
  try {
    const fresh = fs.readFileSync(store.reviews, 'utf8')
    const locked = applyRepair(fresh)
    summary.records = locked.plan.records.length
    summary.damaged = locked.plan.damaged.length
    summary.distinctIds = new Set(locked.plan.records.map((entry) => entry.review.id)).size
    summary.duplicateIds = locked.plan.duplicateIds
    summary.reassigned = locked.plan.reassignments.length

    if (!locked.plan.reassignments.length) return summary

    // Unique backup name, created exclusively: never clobber, never follow a
    // pre-planted link at a predictable path.
    const backup = `${store.reviews}.${new Date().toISOString().replace(/[:.]/g, '')}.bak`
    assertNotSymlink(backup)
    fs.copyFileSync(store.reviews, backup, fs.constants.COPYFILE_EXCL)

    const tmp = `${store.reviews}.${process.pid}.tmp`
    assertNotSymlink(tmp)
    fs.writeFileSync(tmp, locked.content, { flag: 'wx' })
    fs.renameSync(tmp, store.reviews)

    summary.backup = backup
    return summary
  } finally {
    lock.release(held)
  }
}

function main(argv) {
  const write = argv.includes('--write')
  const scanAt = argv.indexOf('--scan')
  const targets = argv.filter((arg) => !arg.startsWith('--'))

  let stores = []
  if (scanAt !== -1) {
    const root = argv[scanAt + 1]
    if (!root || root.startsWith('--')) {
      process.stderr.write('--scan needs a directory\n')
      return 1
    }
    stores = findStores(root)
  } else {
    if (!targets.length) {
      process.stderr.write(
        'usage: repair-bubo-ids.js <project-or-.bubo-path>... [--write]\n' +
        '       repair-bubo-ids.js --scan <dir> [--write]\n'
      )
      return 1
    }
    stores = targets.map((target) => {
      const store = resolveStore(target)
      if (!store) process.stderr.write(`no .bubo/reviews.jsonl under ${target}\n`)
      return store
    }).filter(Boolean)
  }

  if (!stores.length) {
    process.stdout.write('No Bubo stores found.\n')
    return 0
  }

  // --scan can turn up the same store twice via different paths.
  const seen = new Set()
  stores = stores.filter((store) => {
    const key = fs.realpathSync(store.dir)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  process.stdout.write(write ? 'Repairing Bubo stores\n\n' : 'Dry run — nothing is written\n\n')

  let needingRepair = 0
  stores.forEach((store) => {
    const summary = repairStore(store, write)
    if (summary.reassigned) needingRepair += 1

    process.stdout.write(`${summary.dir}\n`)
    process.stdout.write(
      `  ${summary.records} records, ${summary.distinctIds} distinct ids, ` +
      `${summary.duplicateIds} ids reused\n`
    )
    if (summary.damaged) {
      process.stdout.write(`  ${summary.damaged} unparseable lines (left untouched)\n`)
    }
    if (!summary.reassigned) {
      process.stdout.write('  nothing to repair\n\n')
      return
    }
    process.stdout.write(
      write
        ? `  reassigned ${summary.reassigned} records; backup at ${path.basename(summary.backup)}\n\n`
        : `  would reassign ${summary.reassigned} records\n\n`
    )
  })

  if (!write && needingRepair) {
    process.stdout.write(`Re-run with --write to apply (a .bak is kept per store).\n`)
  }
  return 0
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)))
}

module.exports = { applyRepair, findStores, planRepair, repairStore, resolveStore }
