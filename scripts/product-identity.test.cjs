const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const identity = require(path.join(root, 'src/shared/productIdentity.json'))
const packageMetadata = require(path.join(root, 'package.json'))
const builder = require(path.join(root, 'electron-builder.config.cjs'))

test('uses one stable reverse-DNS production identity', () => {
  assert.match(identity.appId, /^[a-z][a-z0-9]*(?:\.[a-z0-9-]+){2,}$/)
  assert.equal(identity.developmentAppId, `${identity.appId}.dev`)
  assert.equal(builder.appId, identity.appId)
  assert.equal(builder.productName, identity.productName)
})

test('keeps project destinations bound to the public source repository', () => {
  const repositoryUrl = `https://github.com/${identity.repositoryOwner}/${identity.repositoryName}`
  assert.equal(packageMetadata.homepage, repositoryUrl)
  assert.equal(packageMetadata.repository.url, `${repositoryUrl}.git`)
  assert.equal(builder.publish, null)
})
