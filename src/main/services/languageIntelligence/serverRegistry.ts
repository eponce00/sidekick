import { accessSync, constants, readdirSync, type Dirent } from 'fs'
import { delimiter, dirname, extname, join, resolve } from 'path'

export interface LanguageServerCommand {
  command: string
  args: string[]
}

export interface LanguageServerDefinition {
  id: string
  name: string
  languages: string[]
  extensions: string[]
  fileNames?: string[]
  rootMarkers: string[]
  commands: LanguageServerCommand[]
  initializationOptions?: unknown
  priority?: number
  requiresRootMarker?: boolean
}

export interface ResolvedLanguageServer extends LanguageServerDefinition {
  command: string
  args: string[]
  origin: 'workspace' | 'path'
}

const command = (name: string, ...args: string[]): LanguageServerCommand => ({
  command: name,
  args
})

/**
 * Server recipes are deliberately data, not protocol logic. SideKick never downloads a compiler or
 * language server: it discovers project-local or PATH-installed servers and starts one only when a
 * relevant file is actually inspected.
 */
export const LANGUAGE_SERVERS: readonly LanguageServerDefinition[] = [
  {
    id: 'typescript',
    name: 'TypeScript language server',
    languages: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'],
    rootMarkers: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    commands: [command('typescript-language-server', '--stdio')]
  },
  {
    id: 'deno',
    name: 'Deno language server',
    languages: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
    rootMarkers: ['deno.json', 'deno.jsonc'],
    commands: [command('deno', 'lsp')],
    priority: 20,
    requiresRootMarker: true
  },
  {
    id: 'vue',
    name: 'Vue language server',
    languages: ['vue'],
    extensions: ['.vue'],
    rootMarkers: ['package.json'],
    commands: [command('vue-language-server', '--stdio')]
  },
  {
    id: 'svelte',
    name: 'Svelte language server',
    languages: ['svelte'],
    extensions: ['.svelte'],
    rootMarkers: ['package.json', 'svelte.config.js'],
    commands: [command('svelteserver', '--stdio')]
  },
  {
    id: 'python',
    name: 'Python language server',
    languages: ['python'],
    extensions: ['.py', '.pyi'],
    rootMarkers: ['pyproject.toml', 'setup.py', 'requirements.txt', '.git'],
    commands: [
      command('basedpyright-langserver', '--stdio'),
      command('pyright-langserver', '--stdio'),
      command('ruff', 'server')
    ]
  },
  {
    id: 'go',
    name: 'Go language server',
    languages: ['go'],
    extensions: ['.go'],
    rootMarkers: ['go.work', 'go.mod', '.git'],
    commands: [command('gopls')]
  },
  {
    id: 'rust',
    name: 'Rust Analyzer',
    languages: ['rust'],
    extensions: ['.rs'],
    rootMarkers: ['Cargo.toml', 'rust-project.json', '.git'],
    commands: [command('rust-analyzer')]
  },
  {
    id: 'clangd',
    name: 'Clangd',
    languages: ['c', 'cpp', 'objective-c', 'objective-cpp'],
    extensions: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.m', '.mm'],
    rootMarkers: ['compile_commands.json', 'compile_flags.txt', 'CMakeLists.txt', '.git'],
    commands: [command('clangd')]
  },
  {
    id: 'csharp',
    name: 'C# language server',
    languages: ['csharp'],
    extensions: ['.cs'],
    rootMarkers: ['.sln', '.csproj', '.git'],
    commands: [command('omnisharp', '-lsp'), command('csharp-ls')]
  },
  {
    id: 'java',
    name: 'Java language server',
    languages: ['java'],
    extensions: ['.java'],
    rootMarkers: ['pom.xml', 'build.gradle', 'build.gradle.kts', '.git'],
    commands: [command('jdtls')]
  },
  {
    id: 'kotlin',
    name: 'Kotlin language server',
    languages: ['kotlin'],
    extensions: ['.kt', '.kts'],
    rootMarkers: ['settings.gradle', 'settings.gradle.kts', '.git'],
    commands: [command('kotlin-language-server')]
  },
  {
    id: 'ruby',
    name: 'Ruby language server',
    languages: ['ruby'],
    extensions: ['.rb', '.rake'],
    fileNames: ['Gemfile', 'Rakefile'],
    rootMarkers: ['Gemfile', '.git'],
    commands: [command('ruby-lsp'), command('solargraph', 'stdio')]
  },
  {
    id: 'php',
    name: 'PHP language server',
    languages: ['php'],
    extensions: ['.php'],
    rootMarkers: ['composer.json', '.git'],
    commands: [command('intelephense', '--stdio'), command('phpactor', 'language-server')]
  },
  {
    id: 'swift',
    name: 'SourceKit-LSP',
    languages: ['swift'],
    extensions: ['.swift'],
    rootMarkers: ['Package.swift', '.git'],
    commands: [command('sourcekit-lsp'), command('xcrun', 'sourcekit-lsp')]
  },
  {
    id: 'dart',
    name: 'Dart language server',
    languages: ['dart'],
    extensions: ['.dart'],
    rootMarkers: ['pubspec.yaml', '.git'],
    commands: [command('dart', 'language-server', '--protocol=lsp')]
  },
  {
    id: 'elixir',
    name: 'Elixir language server',
    languages: ['elixir'],
    extensions: ['.ex', '.exs'],
    rootMarkers: ['mix.exs', '.git'],
    commands: [command('elixir-ls'), command('language_server.sh')]
  },
  {
    id: 'lua',
    name: 'Lua language server',
    languages: ['lua'],
    extensions: ['.lua'],
    rootMarkers: ['.luarc.json', '.git'],
    commands: [command('lua-language-server')]
  },
  {
    id: 'bash',
    name: 'Bash language server',
    languages: ['shellscript'],
    extensions: ['.sh', '.bash', '.zsh'],
    rootMarkers: ['.git'],
    commands: [command('bash-language-server', 'start')]
  },
  {
    id: 'yaml',
    name: 'YAML language server',
    languages: ['yaml'],
    extensions: ['.yaml', '.yml'],
    rootMarkers: ['.git'],
    commands: [command('yaml-language-server', '--stdio')]
  },
  {
    id: 'json',
    name: 'JSON language server',
    languages: ['json', 'jsonc'],
    extensions: ['.json', '.jsonc'],
    rootMarkers: ['package.json', '.git'],
    commands: [command('vscode-json-language-server', '--stdio')]
  },
  {
    id: 'html',
    name: 'HTML language server',
    languages: ['html'],
    extensions: ['.html', '.htm'],
    rootMarkers: ['package.json', '.git'],
    commands: [command('vscode-html-language-server', '--stdio')]
  },
  {
    id: 'css',
    name: 'CSS language server',
    languages: ['css', 'scss', 'less'],
    extensions: ['.css', '.scss', '.less'],
    rootMarkers: ['package.json', '.git'],
    commands: [command('vscode-css-language-server', '--stdio')]
  },
  {
    id: 'terraform',
    name: 'Terraform language server',
    languages: ['terraform'],
    extensions: ['.tf', '.tfvars'],
    rootMarkers: ['.terraform', '.git'],
    commands: [command('terraform-ls', 'serve')]
  },
  {
    id: 'docker',
    name: 'Docker language server',
    languages: ['dockerfile'],
    extensions: [],
    fileNames: ['Dockerfile', 'Containerfile'],
    rootMarkers: ['.git'],
    commands: [command('docker-langserver', '--stdio')]
  },
  {
    id: 'prisma',
    name: 'Prisma language server',
    languages: ['prisma'],
    extensions: ['.prisma'],
    rootMarkers: ['schema.prisma', 'package.json'],
    commands: [command('prisma-language-server', '--stdio')]
  }
]

function executableCandidates(name: string): string[] {
  return process.platform === 'win32' ? [name, `${name}.cmd`, `${name}.exe`, `${name}.bat`] : [name]
}

function executablePath(
  workspaceRoot: string,
  name: string
): { path: string; origin: 'workspace' | 'path' } | null {
  if (name.includes('/') || name.includes('\\')) {
    try {
      accessSync(name, constants.X_OK)
      return { path: name, origin: 'path' }
    } catch {
      return null
    }
  }
  const directories: Array<{ path: string; origin: 'workspace' | 'path' }> = [
    { path: resolve(workspaceRoot, 'node_modules', '.bin'), origin: 'workspace' },
    ...String(process.env.PATH || '')
      .split(delimiter)
      .filter(Boolean)
      .map((path) => ({ path, origin: 'path' as const }))
  ]
  for (const directory of directories) {
    for (const candidate of executableCandidates(name)) {
      const path = join(directory.path, candidate)
      try {
        accessSync(path, constants.X_OK)
        return { path, origin: directory.origin }
      } catch {
        /* continue */
      }
    }
  }
  return null
}

function matches(definition: LanguageServerDefinition, filePath: string): boolean {
  const name = filePath.replaceAll('\\', '/').split('/').at(-1) || ''
  return (
    definition.extensions.includes(extname(name).toLowerCase()) ||
    Boolean(definition.fileNames?.includes(name))
  )
}

export function languageIdForFile(definition: LanguageServerDefinition, filePath: string): string {
  const extension = extname(filePath).toLowerCase()
  const special: Record<string, string> = {
    '.tsx': 'typescriptreact',
    '.jsx': 'javascriptreact',
    '.mts': 'typescript',
    '.cts': 'typescript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.h': 'cpp',
    '.hpp': 'cpp',
    '.cc': 'cpp',
    '.cxx': 'cpp',
    '.m': 'objective-c',
    '.mm': 'objective-cpp',
    '.pyi': 'python',
    '.kts': 'kotlin',
    '.exs': 'elixir',
    '.yml': 'yaml',
    '.jsonc': 'jsonc',
    '.scss': 'scss',
    '.less': 'less',
    '.tfvars': 'terraform'
  }
  if (special[extension]) return special[extension]
  return definition.languages[0]
}

export function definitionsForFile(filePath: string): LanguageServerDefinition[] {
  return LANGUAGE_SERVERS.filter((definition) => matches(definition, filePath))
}

function resolveDefinitionServer(
  workspaceRoot: string,
  definition: LanguageServerDefinition
): ResolvedLanguageServer | null {
  for (const candidate of definition.commands) {
    const executable = executablePath(workspaceRoot, candidate.command)
    if (executable) {
      return {
        ...definition,
        command: executable.path,
        args: candidate.args,
        origin: executable.origin
      }
    }
  }
  return null
}

export function resolveServerForFile(
  workspaceRoot: string,
  filePath: string
): ResolvedLanguageServer | null {
  const definitions = definitionsForFile(filePath)
    .map((definition) => ({
      definition,
      markerRoot: findLanguageServerRoot(workspaceRoot, filePath, definition),
      score:
        (definition.priority ?? 0) +
        (hasSpecificRootMarker(workspaceRoot, filePath, definition) ? 100 : 0)
    }))
    .filter(({ definition, markerRoot }) => !definition.requiresRootMarker || markerRoot !== null)
    .sort((left, right) => right.score - left.score)
  for (const { definition } of definitions) {
    const server = resolveDefinitionServer(workspaceRoot, definition)
    if (server) return server
  }
  return null
}

function hasRootMarker(directory: string, marker: string): boolean {
  if (marker === '.sln' || marker === '.slnx' || marker === '.csproj') {
    try {
      return readdirSync(directory).some((name) => name.endsWith(marker))
    } catch {
      return false
    }
  }
  return existsAt(join(directory, marker))
}

function findLanguageServerRoot(
  workspaceRoot: string,
  filePath: string,
  definition: LanguageServerDefinition,
  markers = definition.rootMarkers
): string | null {
  const boundary = resolve(workspaceRoot)
  let directory = dirname(resolve(boundary, filePath))
  while (
    directory === boundary ||
    directory.startsWith(`${boundary}/`) ||
    directory.startsWith(`${boundary}\\`)
  ) {
    if (markers.some((marker) => hasRootMarker(directory, marker))) return directory
    if (directory === boundary) break
    directory = dirname(directory)
  }
  return null
}

function hasSpecificRootMarker(
  workspaceRoot: string,
  filePath: string,
  definition: LanguageServerDefinition
): boolean {
  return Boolean(
    findLanguageServerRoot(
      workspaceRoot,
      filePath,
      definition,
      definition.rootMarkers.filter((marker) => marker !== '.git')
    )
  )
}

function existsAt(path: string): boolean {
  try {
    accessSync(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export function languageServerRoot(
  workspaceRoot: string,
  filePath: string,
  definition: LanguageServerDefinition
): string {
  return findLanguageServerRoot(workspaceRoot, filePath, definition) ?? resolve(workspaceRoot)
}

export function detectWorkspaceLanguages(workspaceRoot: string, maxEntries = 4_000): string[] {
  const root = resolve(workspaceRoot)
  const found = new Set<string>()
  const ignored = new Set([
    '.git',
    'node_modules',
    'dist',
    'build',
    'out',
    '.next',
    '.cache',
    'coverage',
    'vendor'
  ])
  const queue = [root]
  let visited = 0
  while (queue.length && visited < maxEntries) {
    const directory = queue.shift()!
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (++visited > maxEntries) break
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name) && !entry.isSymbolicLink())
          queue.push(join(directory, entry.name))
        continue
      }
      for (const definition of LANGUAGE_SERVERS) {
        if (matches(definition, entry.name)) found.add(definition.id)
      }
    }
  }
  return [...found]
}

export function availableWorkspaceServers(workspaceRoot: string): ResolvedLanguageServer[] {
  const detected = new Set(detectWorkspaceLanguages(workspaceRoot))
  const resolved: ResolvedLanguageServer[] = []
  for (const definition of LANGUAGE_SERVERS) {
    if (!detected.has(definition.id)) continue
    const representative = definition.fileNames?.[0] || `file${definition.extensions[0] || ''}`
    if (
      definition.requiresRootMarker &&
      !findLanguageServerRoot(workspaceRoot, representative, definition)
    ) {
      continue
    }
    const server = resolveDefinitionServer(workspaceRoot, definition)
    if (server) resolved.push(server)
  }
  return resolved
}
