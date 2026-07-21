const fs = require('node:fs')
const path = require('node:path')

// Whether `dir` is genuinely the top of a git repository.
//
// Merely testing that `.git` exists is not enough. An empty or half-created
// `.git` directory satisfies existsSync while git itself reports "not a git
// repository" for it, and Bubo would then adopt that unrelated ancestor as the
// project — writing review notes into a store belonging to nothing. A stray
// empty /tmp/.git did exactly that here.
//
// Two shapes are legitimate:
//   - a directory containing HEAD (an ordinary repository)
//   - a file beginning with "gitdir:" (a worktree or submodule checkout)
function isGitRoot(dir) {
  const gitPath = path.join(dir, '.git')

  let stat
  try {
    stat = fs.lstatSync(gitPath)
  } catch {
    return false
  }

  if (stat.isDirectory()) {
    return fs.existsSync(path.join(gitPath, 'HEAD'))
  }

  if (stat.isFile()) {
    try {
      // No trimming: git requires "gitdir:" at offset zero and fails with
      // "invalid gitfile format" otherwise. Accepting leading whitespace would
      // adopt a root git itself refuses, which is the bug this guards against.
      return fs.readFileSync(gitPath, 'utf8').startsWith('gitdir:')
    } catch {
      return false
    }
  }

  return false
}

function resolveProjectRoot(start = process.cwd()) {
  let current = path.resolve(start)

  while (true) {
    if (isGitRoot(current)) return current
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(start)
    current = parent
  }
}

module.exports = { isGitRoot, resolveProjectRoot }
