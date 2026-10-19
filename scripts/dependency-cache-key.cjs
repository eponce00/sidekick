#!/usr/bin/env node
// Prints the hash CI keys its cache of installed dependencies on. The installed tree depends on
// the locked dependencies and the Node version, but not on SideKick's own version, which the
// lockfile also records: leaving that out lets a release keep the cache, while any other lockfile
// change still changes the key.
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

function dependencyCacheKey(lockfileText, nodeVersion) {
  const lockfile = JSON.parse(lockfileText)
  delete lockfile.version
  if (lockfile.packages?.['']) delete lockfile.packages[''].version
  return createHash('sha256')
    .update(JSON.stringify(lockfile))
    .update('\0')
    .update(nodeVersion.trim())
    .digest('hex')
}

if (require.main === module) {
  const root = join(__dirname, '..')
  const key = dependencyCacheKey(
    readFileSync(join(root, 'package-lock.json'), 'utf8'),
    readFileSync(join(root, '.node-version'), 'utf8')
  )
  process.stdout.write(`${key}\n`)
}

module.exports = { dependencyCacheKey }
