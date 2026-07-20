const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// Create an isolated project root for a test.
//
// resolveProjectRoot walks up from its starting directory looking for `.git`,
// and only stops at the filesystem root. A bare mkdtemp under os.tmpdir()
// therefore does NOT define a project: if any ancestor of the temp directory is
// a git repository — a stray /tmp/.git is enough — every test resolves to that
// ancestor instead, and all of them share one .bubo store. Tests then see each
// other's reviews, ids continue across cases that expect to start at 1, and the
// suite passes or fails depending on the machine it runs on.
//
// Planting an empty `.git` marker makes the temp directory itself the nearest
// project root, so resolution stops here. Tests that need a real repository can
// still run `git init` over it.
function makeProjectRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.mkdirSync(path.join(root, '.git'), { recursive: true })
  return root
}

module.exports = { makeProjectRoot }
