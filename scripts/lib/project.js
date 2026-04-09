const fs = require('node:fs')
const path = require('node:path')

function resolveProjectRoot(start = process.cwd()) {
  let current = path.resolve(start)

  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(start)
    current = parent
  }
}

module.exports = { resolveProjectRoot }
