import type { EditingDialect } from './workspaceMutations'

export interface AgentToolParameterProperty {
  type: string
  description?: string
  enum?: string[]
  items?: Record<string, unknown>
  properties?: Record<string, AgentToolParameterProperty>
  required?: string[]
  [key: string]: unknown
}

export interface AgentToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      required?: string[]
      properties?: Record<string, AgentToolParameterProperty>
      [key: string]: unknown
    }
  }
}

function schemaRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Produces a portable provider-facing subset of JSON Schema for MCP tools.
 * Local references are resolved because several model APIs reject $defs/$ref,
 * while SideKick's runtime validator must see the same effective contract.
 */
export function normalizeAgentToolParameters(
  input: unknown
): AgentToolDefinition['function']['parameters'] {
  const root = schemaRecord(input)
  const definitions = {
    ...schemaRecord(root.definitions),
    ...schemaRecord(root.$defs)
  }
  const resolving = new Set<string>()

  const normalize = (value: unknown, depth: number): Record<string, unknown> => {
    if (depth > 20) return { type: 'object', description: 'Schema depth was bounded by SideKick.' }
    const source = schemaRecord(value)
    const reference = typeof source.$ref === 'string' ? source.$ref : ''
    const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(reference)
    if (match && !resolving.has(reference)) {
      const target = definitions[decodeURIComponent(match[1])]
      if (target) {
        resolving.add(reference)
        const resolved = normalize(target, depth + 1)
        resolving.delete(reference)
        return resolved
      }
    }

    const normalized: Record<string, unknown> = {}
    const rawType = source.type
    const supportedTypes = Array.isArray(rawType)
      ? rawType.filter((type): type is string => typeof type === 'string' && type !== 'null')
      : typeof rawType === 'string'
        ? [rawType]
        : []
    if (supportedTypes.length === 1) normalized.type = supportedTypes[0]
    else if (supportedTypes.length > 1) normalized.anyOf = supportedTypes.map((type) => ({ type }))
    if (typeof source.description === 'string') normalized.description = source.description
    if (Array.isArray(source.enum)) normalized.enum = source.enum
    else if ('const' in source) normalized.enum = [source.const]
    for (const key of [
      'minimum',
      'maximum',
      'exclusiveMinimum',
      'exclusiveMaximum',
      'minLength',
      'maxLength',
      'pattern',
      'minItems',
      'maxItems'
    ]) {
      if (typeof source[key] === 'number' || typeof source[key] === 'string') {
        normalized[key] = source[key]
      }
    }
    if (source.items) normalized.items = normalize(source.items, depth + 1)
    const properties = schemaRecord(source.properties)
    if (Object.keys(properties).length) {
      normalized.type = 'object'
      normalized.properties = Object.fromEntries(
        Object.entries(properties).map(([name, schema]) => [name, normalize(schema, depth + 1)])
      )
      if (Array.isArray(source.required)) {
        normalized.required = source.required.filter(
          (name): name is string => typeof name === 'string' && name in properties
        )
      }
    }
    for (const keyword of ['anyOf', 'oneOf'] as const) {
      if (Array.isArray(source[keyword])) {
        normalized[keyword] = source[keyword].map((schema) => normalize(schema, depth + 1))
      }
    }
    if (!normalized.type && !normalized.anyOf && !normalized.oneOf) normalized.type = 'object'
    return normalized
  }

  const normalized = normalize(root, 0)
  return {
    ...normalized,
    type: 'object',
    properties: schemaRecord(normalized.properties) as Record<string, AgentToolParameterProperty>
  } as AgentToolDefinition['function']['parameters']
}

const accessLevel: AgentToolParameterProperty = {
  type: 'string',
  enum: ['auto', 'confirm'],
  description:
    'Use auto for routine, reversible project edits. Use confirm for sensitive, surprising, destructive, or broad changes.'
}

const filePath: AgentToolParameterProperty = {
  type: 'string',
  description: 'Path relative to the project root.'
}

function exactEditDefinition(name: 'Edit' | 'search_replace' | 'edit'): AgentToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description:
        'Replace exact text in a project file. Read the relevant file first. You must explicitly set replace_all: false for one unique match or replace_all: true only when every match should change. If a false edit reports multiple matches, retry once with more surrounding context or set replace_all to true. To create or intentionally replace a complete file, use the write tool.',
      parameters: {
        type: 'object',
        required: ['file_path', 'old_string', 'new_string', 'replace_all', 'accessLevel'],
        properties: {
          file_path: filePath,
          old_string: {
            type: 'string',
            description:
              'Exact current file text to replace. An empty string is allowed only when creating a missing or empty file.'
          },
          new_string: {
            type: 'string',
            description: 'Replacement text; must differ from old_string.'
          },
          replace_all: {
            type: 'boolean',
            description:
              'Required replacement intent. Set false when old_string identifies one unique location. Set true only when every exact occurrence should be replaced.'
          },
          accessLevel
        }
      }
    }
  }
}

function writeDefinition(name: 'Write' | 'write'): AgentToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description:
        'Create a new project file or intentionally replace an existing file with complete content. Read an existing file first; SideKick binds the write to that run-scoped read receipt and rejects stale or missing receipts. Identical content is rejected as a no-op. Use the edit tool for localized changes.',
      parameters: {
        type: 'object',
        required: ['file_path', 'content', 'accessLevel'],
        properties: {
          file_path: filePath,
          content: { type: 'string', description: 'Complete desired file content.' },
          accessLevel
        }
      }
    }
  }
}

function deleteDefinition(): AgentToolDefinition {
  return {
    type: 'function',
    function: {
      name: 'delete_file',
      description:
        'Delete a project file only when its intended final state is absent. Read it first; SideKick rejects stale or missing run-scoped read receipts. Never delete a file merely to work around a failed edit or before recreating the same path.',
      parameters: {
        type: 'object',
        required: ['file_path', 'accessLevel'],
        properties: { file_path: filePath, accessLevel }
      }
    }
  }
}

function applyPatchDefinition(): AgentToolDefinition {
  return {
    type: 'function',
    function: {
      name: 'apply_patch',
      description: `Apply one verified, potentially multi-file patch using the canonical Codex patch grammar. The entire patch is parsed and checked before any file is written. Any empty patch, stale or ambiguous hunk, invalid path, skipped hunk, or no-op fails the complete call.

Format:
*** Begin Patch
*** Add File: path/to/new.ts
+new content
*** Update File: path/to/existing.ts
@@ optional function or class marker
 context line
-old line
+new line
 context line
*** Delete File: path/to/obsolete.ts
*** End Patch

Update hunks are context-based, not line-number based. Read every existing target first; SideKick rejects stale or missing run-scoped read receipts. Every hunk line must begin with a space, +, or -. Add-file content lines must begin with +. Paths must be project-relative. Use *** Move to: new/path immediately after an Update File header to rename while editing.`,
      parameters: {
        type: 'object',
        required: ['patch', 'accessLevel'],
        properties: {
          patch: { type: 'string', description: 'Complete canonical patch text.' },
          accessLevel
        }
      }
    }
  }
}

export function editingToolDefinitions(dialect: EditingDialect): AgentToolDefinition[] {
  if (dialect === 'apply-patch') return [applyPatchDefinition()]
  if (dialect === 'claude-edit')
    return [exactEditDefinition('Edit'), writeDefinition('Write'), deleteDefinition()]
  if (dialect === 'search-replace') {
    return [exactEditDefinition('search_replace'), writeDefinition('write'), deleteDefinition()]
  }
  return [exactEditDefinition('edit'), writeDefinition('write'), deleteDefinition()]
}

/** File browsing definitions shared by normal chats and collaborative project agents. */
export function workspaceReadToolDefinitions(): AgentToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'list_workspace_files',
        description:
          'List project files and directories using project-relative paths. Directories end with /. Use glob and sub_path to narrow large trees.',
        parameters: {
          type: 'object',
          properties: {
            sub_path: { type: 'string', description: 'Optional project-relative directory.' },
            glob: { type: 'string', description: 'Optional glob such as **/*.tsx.' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_workspace_file',
        description:
          'Read a UTF-8 project file. Lines are numbered for reference; the number prefix is not part of the file. Use start_line and end_line for focused reads.',
        parameters: {
          type: 'object',
          required: ['file_path'],
          properties: {
            file_path: filePath,
            start_line: {
              type: 'number',
              minimum: 1,
              description: 'Optional 1-based inclusive start line.'
            },
            end_line: {
              type: 'number',
              minimum: 1,
              description: 'Optional 1-based inclusive end line.'
            }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_workspace_files',
        description:
          'Search project files with a regular expression and return matching lines with bounded context.',
        parameters: {
          type: 'object',
          required: ['regex'],
          properties: {
            regex: {
              type: 'string',
              minLength: 1,
              maxLength: 10_000,
              description: 'JavaScript-compatible regular expression.'
            },
            path: {
              type: 'string',
              description:
                'Optional project-relative file or directory. A file path searches only that file.'
            },
            file_pattern: { type: 'string', description: 'Optional glob filter.' },
            context_lines: {
              type: 'number',
              minimum: 0,
              maximum: 5,
              description: 'Context lines around each match, maximum 5.'
            }
          }
        }
      }
    }
  ]
}

export function workspaceToolDefinitions(dialect: EditingDialect): AgentToolDefinition[] {
  return [...workspaceReadToolDefinitions(), ...editingToolDefinitions(dialect)]
}
