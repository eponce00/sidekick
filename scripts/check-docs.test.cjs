const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { githubSlug, portablePath, validateDocumentation } = require('./check-docs.cjs')

function createRepository(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-docs-'))
  for (const [relativePath, content] of Object.entries(files)) {
    const file = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  return root
}

test('githubSlug follows the heading anchors used by the documentation', () => {
  assert.equal(githubSlug('Plan, act, and verify'), 'plan-act-and-verify')
  assert.equal(githubSlug('`AGENTS.md` rules'), 'agentsmd-rules')
})

test('portablePath emits stable diagnostics on Windows', () => {
  assert.equal(portablePath('docs\\user-guide\\TOOLS.md'), 'docs/user-guide/TOOLS.md')
})

test('accepts a valid public documentation set', (context) => {
  const root = createRepository({
    'package.json': '{"version":"1.2.3"}',
    'README.md':
      '<h1>Example</h1>\n<img src="./docs/image.png" alt="Example screen" />\n' +
      '[Guide](./docs/GUIDE.md#details)\n```md\n# Not a heading\n[Not a link](missing.md)\n```\n' +
      'source-v1.2.3-green\nSource version 1.2.3\n',
    'CHANGELOG.md': '# Changelog\n',
    'CONTRIBUTING.md': '# Contributing\n',
    'PRIVACY.md': '# Privacy\n',
    'SECURITY.md': '# Security\n',
    'docs/README.md': '# Documentation\n',
    'docs/GUIDE.md': '# Guide\n\n## Details\n',
    'docs/image.png': 'not-an-image-but-a-valid-link-target'
  })
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))

  assert.deepEqual(validateDocumentation(root).errors, [])
})

test('reports structural, link, privacy, image, and version errors', (context) => {
  const root = createRepository({
    'package.json': '{"version":"2.0.0"}',
    'README.md':
      '# One\n# Two\n![](missing.png)\n[Section](docs/GUIDE.md#missing)\n' +
      'A leaked /Users/example/private/file.\nsource-v1.0.0-green\nSource version 1.0.0\n',
    'CHANGELOG.md': '# Changelog\n',
    'CONTRIBUTING.md': '# Contributing\n',
    'PRIVACY.md': '# Privacy\n',
    'SECURITY.md': '# Security\n',
    'docs/README.md': '# Documentation\n',
    'docs/GUIDE.md': '# Guide\n\n## Present\n'
  })
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const errors = validateDocumentation(root).errors.join('\n')
  assert.match(errors, /expected exactly one H1, found 2/)
  assert.match(errors, /image must have meaningful alternative text/)
  assert.match(errors, /broken local link: missing\.png/)
  assert.match(errors, /missing Markdown anchor: docs\/GUIDE\.md#missing/)
  assert.match(errors, /machine-specific macOS home path/)
  assert.match(errors, /source badge does not match package version 2\.0\.0/)
  assert.match(errors, /source badge alt text does not match package version 2\.0\.0/)
})

test('requires the canonical public entry points', (context) => {
  const root = createRepository({
    'package.json': '{"version":"1.0.0"}',
    'README.md': '<h1>Example</h1>\nsource-v1.0.0-green\nSource version 1.0.0\n',
    'CHANGELOG.md': '# Changelog\n'
  })
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const errors = validateDocumentation(root).errors.join('\n')
  assert.match(errors, /CONTRIBUTING\.md:1: required public document is missing/)
  assert.match(errors, /PRIVACY\.md:1: required public document is missing/)
  assert.match(errors, /SECURITY\.md:1: required public document is missing/)
  assert.match(errors, /docs\/README\.md:1: required public document is missing/)
})
