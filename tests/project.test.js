const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { isGitRoot, resolveProjectRoot } = require('../scripts/lib/project')

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function realRepo(dir) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  return dir
}

test('a directory holding a real .git directory is the project root', () => {
  const root = realRepo(tempDir('bubo-proj-repo-'))
  const nested = path.join(root, 'src', 'deep')
  fs.mkdirSync(nested, { recursive: true })

  assert.equal(resolveProjectRoot(nested), root)
})

// Worktrees and submodules record .git as a FILE pointing elsewhere. Requiring a
// directory would silently relocate every worktree's .bubo store.
test('a git worktree, where .git is a file, is a project root', () => {
  const root = tempDir('bubo-proj-worktree-')
  fs.writeFileSync(path.join(root, '.git'), 'gitdir: /somewhere/.git/worktrees/feature\n')
  const nested = path.join(root, 'src')
  fs.mkdirSync(nested, { recursive: true })

  assert.equal(resolveProjectRoot(nested), root)
})

// The bug this guards: an empty or half-created .git satisfies existsSync but is
// not a repository. git itself reports "not a git repository" for it, and Bubo
// must agree, or it adopts an unrelated ancestor as the project and writes
// review notes into the wrong store.
// These assert on the fake ancestor specifically rather than on the exact
// return value: whatever sits above the temp directory on a given machine is
// not ours to control, and a genuine repository up there is a legitimate answer.
// The invariant under test is that the *invalid* marker is never adopted.
test('an empty .git directory is not a project root', () => {
  const outer = tempDir('bubo-proj-fake-')
  fs.mkdirSync(path.join(outer, '.git'))
  const inner = path.join(outer, 'workdir')
  fs.mkdirSync(inner)

  assert.equal(isGitRoot(outer), false)
  assert.notEqual(resolveProjectRoot(inner), outer, 'must not adopt the fake ancestor')
})

// git parses a gitfile strictly: the content must begin with "gitdir:" at
// offset zero. Leading whitespace makes git fail with "invalid gitfile format",
// so tolerating it here would re-admit the very wrong-root bug this guards
// against — Bubo would adopt a root git itself refuses.
test('a gitdir pointer with leading whitespace is not a project root', () => {
  const outer = tempDir('bubo-proj-ws-')
  fs.writeFileSync(path.join(outer, '.git'), '  gitdir: /somewhere/.git/worktrees/feature\n')
  const inner = path.join(outer, 'workdir')
  fs.mkdirSync(inner)

  assert.equal(isGitRoot(outer), false)
  assert.notEqual(resolveProjectRoot(inner), outer)
})

test('a .git file that is not a gitdir pointer is not a project root', () => {
  const outer = tempDir('bubo-proj-garbage-')
  fs.writeFileSync(path.join(outer, '.git'), 'notes to self\n')
  const inner = path.join(outer, 'workdir')
  fs.mkdirSync(inner)

  assert.equal(isGitRoot(outer), false)
  assert.notEqual(resolveProjectRoot(inner), outer)
})

test('the nearest valid root wins over a further one', () => {
  const outer = realRepo(tempDir('bubo-proj-nearest-'))
  const inner = realRepo(path.join(outer, 'vendored'))
  const nested = path.join(inner, 'src')
  fs.mkdirSync(nested, { recursive: true })

  assert.equal(resolveProjectRoot(nested), inner)
})

// The contract is that resolution never lands on a directory that is not a
// repository: it returns a real root, or falls back to where it started. Which
// of the two happens depends on the machine's directory tree above tmpdir.
test('resolution returns a real repository root, or the starting directory', () => {
  const root = tempDir('bubo-proj-none-')
  const resolved = resolveProjectRoot(root)

  assert.ok(
    resolved === root || isGitRoot(resolved),
    `resolved to ${resolved}, which is neither the start nor a real repository`
  )
})
