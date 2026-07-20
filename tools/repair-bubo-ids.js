#!/usr/bin/env node

// Standalone repair for Bubo stores that contain reused review ids.
//
// Deriving ids from a counter in state.json let the counter rewind (silently,
// on any unreadable state file) while reviews.jsonl kept appending, so one id
// can own several records. `implement <id>` then resolves to whichever record
// came first — usually a long-stale note.
//
// This script reassigns ids so every record is uniquely addressable again.
// It is deliberately self-contained: no dependency on the Bubo plugin, so it
// can be run against any checkout or copied to another machine.
//
//   node tools/repair-bubo-ids.js <project-or-.bubo-path>...   # dry run
//   node tools/repair-bubo-ids.js --scan ~/programming          # find stores
//   node tools/repair-bubo-ids.js <path> --write                # apply
//
// Repair policy: the earliest record in each duplicated id group keeps the id,
// because that is the record the old lookup already resolved to, so any
// reference written down elsewhere still points at the same note. Later
// duplicates are reassigned above the store's high-water mark, oldest first.
// Unparseable lines are preserved verbatim and reported, never dropped.

const fs = require('node:fs')
const path = require('node:path')

function parseStore(raw) {
  const records = []
  const damaged = []

  raw.split('\n').filter(Boolean).forEach((line, index) => {
    try {
      records.push({ review: JSON.parse(line), line, index })
    } catch {
      damaged.push({ line, index })
    }
  })

  return { records, damaged }
}

function sortKey(entry) {
  // Timestamp first so reassignment follows real chronology; file order breaks
  // ties so the result is deterministic for records written in the same ms.
  return [String(entry.review.timestamp || ''), entry.index]
}

function planRepair(raw) {
  const { records, damaged } = parseStore(raw)

  const groups = new Map()
  records.forEach((entry) => {
    const id = entry.review.id
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(entry)
  })

  const numericIds = records
    .map((entry) => entry.review.id)
    .filter((id) => Number.isInteger(id))
  let nextId = numericIds.length ? Math.max(...numericIds) + 1 : 1

  const reassignments = []

  Array.from(groups.entries())
    .filter(([, entries]) => entries.length > 1)
    .sort((a, b) => (a[0] > b[0] ? 1 : -1))
    .forEach(([id, entries]) => {
      const ordered = [...entries].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1))
      // ordered[0] keeps `id`; everything after it gets a fresh one.
      ordered.slice(1).forEach((entry) => {
        reassignments.push({ from: id, to: nextId, entry })
        nextId += 1
      })
    })

  return { records, damaged, reassignments, nextId, duplicateIds:
    Array.from(groups.values()).filter((entries) => entries.length > 1).length }
}

function applyRepair(raw) {
  const plan = planRepair(raw)
  const newIdByIndex = new Map(plan.reassignments.map((r) => [r.entry.index, r.to]))

  // Rebuild in original file order, so the append-only history stays readable.
  const lines = []
  const all = [
    ...plan.records.map((entry) => ({ index: entry.index, entry, kind: 'record' })),
    ...plan.damaged.map((entry) => ({ index: entry.index, entry, kind: 'damaged' }))
  ].sort((a, b) => a.index - b.index)

  all.forEach((item) => {
    if (item.kind === 'damaged') {
      lines.push(item.entry.line)
      return
    }
    const review = item.entry.review
    const replacement = newIdByIndex.get(item.entry.index)
    lines.push(JSON.stringify(replacement ? { ...review, id: replacement } : review))
  })

  return { plan, content: lines.length ? `${lines.join('\n')}\n` : '' }
}

// state.json's nextId is vestigial once ids come from reviews.jsonl; leaving a
// stale counter behind only invites confusion about which file is authoritative.
function pruneState(statePath, write) {
  if (!fs.existsSync(statePath)) return null

  let state
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  } catch {
    return { corrupt: true }
  }

  if (!('nextId' in state)) return null
  delete state.nextId

  if (write) {
    const tmp = `${statePath}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
    fs.renameSync(tmp, statePath)
  }

  return { prunedNextId: true }
}

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

function repairStore(store, write) {
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

  const backup = `${store.reviews}.bak`
  fs.copyFileSync(store.reviews, backup)

  const tmp = `${store.reviews}.${process.pid}.tmp`
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, store.reviews)

  summary.backup = backup
  summary.state = pruneState(path.join(store.dir, 'state.json'), true)
  return summary
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

module.exports = { applyRepair, findStores, planRepair, resolveStore }
