const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { compact, resolveStore } = require('../tools/compact-bubo-store')
const lock = require('../scripts/lib/lock')

const TOOL = path.join(__dirname, '..', 'tools', 'compact-bubo-store.js')

function store(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-compact-'))
  const bubo = path.join(dir, '.bubo')
  fs.mkdirSync(bubo)
  fs.writeFileSync(path.join(bubo, 'reviews.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return { dir, bubo, reviews: path.join(bubo, 'reviews.jsonl') }
}

// Collect the streamed output into a string, the way the CLI streams to a file.
async function compactToString(reviewsPath) {
  let out = ''
  const counts = await compact(reviewsPath, (chunk) => { out += chunk })
  return { out, counts }
}

test('compaction drops the recursive recentReviews payload', async () => {
  const bloated = {
    id: 2, timestamp: 't', reason: 'test-fail', rendered: 'r', problem: 'p',
    context: {
      reason: 'test-fail',
      recentReviews: [
        { id: 1, problem: 'prior', rendered: 'x', context: { toolOutputExcerpt: 'Q'.repeat(2_000_000) } }
      ]
    }
  }
  const s = store([{ id: 1, timestamp: 't', rendered: 'a', context: {} }, bloated])

  const { out, counts } = await compactToString(s.reviews)
  assert.ok(counts.after < counts.before, 'file shrank')
  assert.ok(counts.after < 5000, `still ${counts.after} bytes`)

  const records = out.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.equal(records.length, 2, 'no record dropped')
  const compacted = records.find((r) => r.id === 2)
  assert.equal('context' in compacted.context.recentReviews[0], false)
  assert.equal(compacted.rendered, 'r')
})

test('ids, timestamps and rendered notes are preserved exactly', async () => {
  const s = store([
    { id: 7, timestamp: '2026-07-01T00:00:00Z', reason: 'turn', rendered: 'keep me', problem: 'p',
      context: { diffExcerpt: 'D'.repeat(100000) } }
  ])
  const { out } = await compactToString(s.reviews)
  const record = JSON.parse(out.trim())
  assert.equal(record.id, 7)
  assert.equal(record.timestamp, '2026-07-01T00:00:00Z')
  assert.equal(record.rendered, 'keep me')
  assert.ok(record.context.diffExcerpt.length < 9000, 'oversized excerpt capped')
})

test('an already-lean store is left effectively unchanged', async () => {
  const s = store([
    { id: 1, timestamp: 't', reason: 'turn', rendered: 'a', context: { diffExcerpt: 'short' } }
  ])
  const { out, counts } = await compactToString(s.reviews)
  assert.equal(counts.compacted, 0)
  const record = JSON.parse(out.trim())
  assert.equal(record.context.diffExcerpt, 'short')
})

test('unparseable and non-object lines survive compaction verbatim', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-compact-damaged-'))
  const bubo = path.join(dir, '.bubo')
  fs.mkdirSync(bubo)
  const reviews = path.join(bubo, 'reviews.jsonl')
  fs.writeFileSync(reviews, [
    JSON.stringify({ id: 1, rendered: 'ok', context: { diffExcerpt: 'D'.repeat(100000) } }),
    '{"id": 2, broken',
    'null',
    '42',
    JSON.stringify({ id: 3, rendered: 'also ok', context: {} })
  ].join('\n') + '\n')

  const { out, counts } = await compactToString(reviews)
  assert.equal(counts.damaged, 3, 'broken line, null and bare number are all damaged')
  const lines = out.split('\n').filter(Boolean)
  assert.equal(lines.length, 5)
  assert.equal(lines[1], '{"id": 2, broken')
  assert.equal(lines[2], 'null')
  assert.equal(lines[3], '42')
})

// A record whose id cannot survive a JSON round-trip must be passed through
// untouched, never silently rounded.
test('a record with an unsafe-integer id is left byte-verbatim', async () => {
  const original = '{"id":9007199254740993,"rendered":"x","context":{"diffExcerpt":"' + 'D'.repeat(100000) + '"}}'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-compact-unsafe-'))
  const bubo = path.join(dir, '.bubo')
  fs.mkdirSync(bubo)
  const reviews = path.join(bubo, 'reviews.jsonl')
  fs.writeFileSync(reviews, original + '\n')

  const { out, counts } = await compactToString(reviews)
  assert.equal(counts.unsafeId, 1)
  assert.equal(out.trim(), original, 'the unsafe id and its whole record are untouched')
})

test('resolveStore accepts a project dir or a .bubo dir', () => {
  const s = store([{ id: 1, rendered: 'a' }])
  assert.ok(resolveStore(s.dir))
  assert.ok(resolveStore(path.join(s.dir, '.bubo')))
  assert.equal(resolveStore(path.join(s.dir, 'nope')), null)
})

// --- The --write transaction (M5) ---

test('--write replaces the store, keeps a backup, and preserves every record', () => {
  const s = store([
    { id: 1, timestamp: 't1', rendered: 'a', context: { diffExcerpt: 'D'.repeat(200000) } },
    { id: 2, timestamp: 't2', rendered: 'b', context: {} }
  ])
  const before = fs.readFileSync(s.reviews, 'utf8')

  const result = spawnSync('node', [TOOL, s.dir, '--write'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Compacted\. Backup at/)

  const after = fs.readFileSync(s.reviews, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.equal(after.length, 2)
  assert.deepEqual(after.map((r) => r.id), [1, 2])
  assert.ok(after[0].context.diffExcerpt.length < 9000, 'the big record was compacted')

  const backups = fs.readdirSync(s.bubo).filter((n) => n.endsWith('.precompact.bak'))
  assert.equal(backups.length, 1, 'exactly one backup kept')
  assert.equal(fs.readFileSync(path.join(s.bubo, backups[0]), 'utf8'), before, 'backup is the pre-compaction store')
})

test('--write leaves no temp file behind', () => {
  const s = store([{ id: 1, rendered: 'a', context: { diffExcerpt: 'D'.repeat(200000) } }])
  spawnSync('node', [TOOL, s.dir, '--write'], { encoding: 'utf8' })
  const temps = fs.readdirSync(s.bubo).filter((n) => n.includes('.compact.tmp'))
  assert.deepEqual(temps, [])
})

test('--write on a lean store makes no backup and no change', () => {
  const s = store([{ id: 1, rendered: 'a', context: { diffExcerpt: 'short' } }])
  const before = fs.readFileSync(s.reviews, 'utf8')

  const result = spawnSync('node', [TOOL, s.dir, '--write'], { encoding: 'utf8' })
  assert.match(result.stdout, /Nothing to compact/)
  assert.equal(fs.readFileSync(s.reviews, 'utf8'), before)
  assert.deepEqual(fs.readdirSync(s.bubo).filter((n) => n.endsWith('.bak')), [])
})

test('--write waits on a held lock rather than racing it', () => {
  const s = store([{ id: 1, rendered: 'a', context: { diffExcerpt: 'D'.repeat(200000) } }])
  // A live holder occupies the lock; the compactor must not proceed.
  const held = lock.acquire(s.bubo, { timeoutMs: 1000 })
  try {
    const result = spawnSync('node', [TOOL, s.dir, '--write'], {
      encoding: 'utf8',
      env: { ...process.env, BUBO_LOCK_TIMEOUT_MS: '300' }
    })
    // The child should fail to acquire within its (shortened) timeout and exit
    // non-zero, having changed nothing.
    assert.notEqual(result.status, 0)
    assert.match((result.stderr || '') + (result.stdout || ''), /Timed out waiting for the Bubo store lock/i)
  } finally {
    lock.release(held)
  }
})
