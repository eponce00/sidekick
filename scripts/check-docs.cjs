#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const ROOT_DOCUMENTS = [
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'PRIVACY.md',
  'SECURITY.md',
  '.github/copilot-instructions.md'
]
const REQUIRED_DOCUMENTS = [
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'PRIVACY.md',
  'SECURITY.md',
  'docs/README.md'
]
const LOCAL_PATH_PATTERNS = [
  { label: 'macOS home path', expression: /\/Users\/[A-Za-z0-9._-]+\//g },
  { label: 'Linux home path', expression: /\/home\/[A-Za-z0-9._-]+\//g },
  { label: 'Windows home path', expression: /[A-Za-z]:\\Users\\[A-Za-z0-9._ -]+\\/g },
  { label: 'file URL', expression: /file:\/\//gi }
]

function walkMarkdown(directory) {
  if (!fs.existsSync(directory)) return []

  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return walkMarkdown(entryPath)
    return entry.isFile() && entry.name.endsWith('.md') ? [entryPath] : []
  })
}

function publicMarkdownFiles(root) {
  const rootFiles = ROOT_DOCUMENTS.map((file) => path.join(root, file)).filter(fs.existsSync)
  return [...rootFiles, ...walkMarkdown(path.join(root, 'docs'))].sort()
}

function withoutFencedCode(markdown) {
  let fenceCharacter = null
  let fenceLength = 0

  return markdown
    .split(/\r?\n/)
    .map((line) => {
      if (!fenceCharacter) {
        const opening = /^[ \t]*(`{3,}|~{3,})/.exec(line)
        if (!opening) return line
        fenceCharacter = opening[1][0]
        fenceLength = opening[1].length
        return ''
      }

      const closing = new RegExp(`^[ \\t]*${fenceCharacter}{${fenceLength},}[ \\t]*$`)
      if (closing.test(line)) {
        fenceCharacter = null
        fenceLength = 0
      }
      return ''
    })
    .join('\n')
}

function githubSlug(value) {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
}

function headingData(markdown) {
  const counts = new Map()
  const anchors = new Set()
  let h1Count = 0

  for (const line of withoutFencedCode(markdown).split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (!heading) continue
    if (heading[1].length === 1) h1Count += 1

    const base = githubSlug(heading[2])
    if (!base) continue
    const duplicateIndex = counts.get(base) || 0
    counts.set(base, duplicateIndex + 1)
    anchors.add(duplicateIndex === 0 ? base : `${base}-${duplicateIndex}`)
  }

  const htmlH1Count = (withoutFencedCode(markdown).match(/<h1\b[^>]*>/gi) || []).length
  return { anchors, h1Count: h1Count + htmlH1Count }
}

function lineForOffset(markdown, offset) {
  return markdown.slice(0, offset).split(/\r?\n/).length
}

function normalizeTarget(rawTarget) {
  const trimmed = rawTarget.trim()
  if (trimmed.startsWith('<')) {
    const close = trimmed.indexOf('>')
    return close === -1 ? trimmed.slice(1) : trimmed.slice(1, close)
  }
  return trimmed.split(/\s+["']/u, 1)[0]
}

function collectLinks(markdown) {
  const source = withoutFencedCode(markdown)
  const links = []
  const markdownLink = /(!?)\[([^\]]*)\]\(([^)]+)\)/g
  const htmlLink = /<(a|img)\b[^>]*?\b(?:href|src)\s*=\s*["']([^"']+)["'][^>]*>/gi

  for (const match of source.matchAll(markdownLink)) {
    links.push({
      target: normalizeTarget(match[3]),
      image: match[1] === '!',
      alt: match[2],
      line: lineForOffset(source, match.index)
    })
  }

  for (const match of source.matchAll(htmlLink)) {
    const image = match[1].toLowerCase() === 'img'
    const alt = image ? /\balt\s*=\s*["']([^"']*)["']/i.exec(match[0])?.[1] || '' : undefined
    links.push({
      target: match[2],
      image,
      alt,
      line: lineForOffset(source, match.index)
    })
  }

  return links
}

function splitTarget(target) {
  const hashIndex = target.indexOf('#')
  if (hashIndex === -1) return { file: target, anchor: '' }
  return {
    file: target.slice(0, hashIndex),
    anchor: target.slice(hashIndex + 1)
  }
}

function isExternalTarget(target) {
  return /^(?:https?:|mailto:|data:)/i.test(target)
}

function portablePath(value) {
  return value.replaceAll('\\', '/')
}

function validateDocumentation(root) {
  const errors = []
  const files = publicMarkdownFiles(root)
  const fileContents = new Map(files.map((file) => [file, fs.readFileSync(file, 'utf8')]))
  const headings = new Map(files.map((file) => [file, headingData(fileContents.get(file))]))

  const report = (file, line, message) => {
    const relative = portablePath(path.relative(root, file) || path.basename(file))
    errors.push(`${relative}:${line}: ${message}`)
  }

  for (const required of REQUIRED_DOCUMENTS) {
    const requiredPath = path.join(root, required)
    if (!fs.existsSync(requiredPath)) report(requiredPath, 1, 'required public document is missing')
  }

  for (const [file, markdown] of fileContents) {
    const { h1Count } = headings.get(file)
    if (h1Count !== 1) report(file, 1, `expected exactly one H1, found ${h1Count}`)

    for (const pattern of LOCAL_PATH_PATTERNS) {
      pattern.expression.lastIndex = 0
      for (const match of markdown.matchAll(pattern.expression)) {
        report(
          file,
          lineForOffset(markdown, match.index),
          `contains a machine-specific ${pattern.label}`
        )
      }
    }

    for (const link of collectLinks(markdown)) {
      if (link.image && !link.alt.trim()) {
        report(file, link.line, 'image must have meaningful alternative text')
      }
      if (!link.target || isExternalTarget(link.target)) continue

      const { file: targetText, anchor: rawAnchor } = splitTarget(link.target)
      let anchor = ''
      try {
        anchor = decodeURIComponent(rawAnchor).toLowerCase()
      } catch {
        report(file, link.line, `link has invalid URL encoding: ${link.target}`)
        continue
      }
      let targetFile = file
      if (targetText) {
        let decodedTarget
        try {
          decodedTarget = decodeURIComponent(targetText)
        } catch {
          report(file, link.line, `link has invalid URL encoding: ${link.target}`)
          continue
        }
        targetFile = path.resolve(path.dirname(file), decodedTarget)
        const relativeTarget = path.relative(root, targetFile)
        if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
          report(file, link.line, `local link escapes the repository: ${link.target}`)
          continue
        }
        if (!fs.existsSync(targetFile)) {
          report(file, link.line, `broken local link: ${link.target}`)
          continue
        }
      }

      if (anchor) {
        if (path.extname(targetFile).toLowerCase() !== '.md') {
          report(file, link.line, `anchor target is not Markdown: ${link.target}`)
          continue
        }
        if (!headings.has(targetFile)) {
          const targetMarkdown = fs.readFileSync(targetFile, 'utf8')
          headings.set(targetFile, headingData(targetMarkdown))
        }
        if (!headings.get(targetFile).anchors.has(anchor)) {
          report(file, link.line, `missing Markdown anchor: ${link.target}`)
        }
      }
    }
  }

  const packagePath = path.join(root, 'package.json')
  const readmePath = path.join(root, 'README.md')
  if (fs.existsSync(packagePath) && fs.existsSync(readmePath)) {
    const version = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version
    const readme = fileContents.get(readmePath) || fs.readFileSync(readmePath, 'utf8')
    if (!readme.includes(`source-v${version}-`)) {
      report(readmePath, 1, `source badge does not match package version ${version}`)
    }
    if (!readme.includes(`Source version ${version}`)) {
      report(readmePath, 1, `source badge alt text does not match package version ${version}`)
    }
  }

  return { files, errors }
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..')
  const result = validateDocumentation(root)
  if (result.errors.length > 0) {
    console.error(`Documentation validation failed with ${result.errors.length} error(s):`)
    for (const error of result.errors) console.error(`- ${error}`)
    process.exitCode = 1
  } else {
    console.log(`Documentation validation passed for ${result.files.length} files.`)
  }
}

module.exports = {
  collectLinks,
  githubSlug,
  headingData,
  portablePath,
  validateDocumentation
}
