const SAFE_EXECUTABLES = new Set([
  'cat',
  'dir',
  'echo',
  'find',
  'findstr',
  'get-childitem',
  'get-content',
  'get-item',
  'grep',
  'head',
  'ls',
  'measure-object',
  'pwd',
  'resolve-path',
  'rg',
  'select-string',
  'tail',
  'test-path',
  'type',
  'where',
  'where.exe',
  'which'
])

const SAFE_GIT_SUBCOMMANDS = new Set([
  'branch',
  'diff',
  'grep',
  'log',
  'rev-parse',
  'show',
  'status'
])

const MUTATING_SHELL_SYNTAX = /(?:^|\s)(?:>|>>|2>|2>>|&>|tee|out-file|set-content|add-content)(?:\s|$)/i
const CONTROL_OPERATOR = /(?:&&|\|\||;|\||\r?\n)/

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, '')
}

/** Conservative classifier for the optional Sensitive actions mode. */
export function commandCanRunWithoutApproval(command: string): boolean {
  const normalized = command.trim()
  if (!normalized || MUTATING_SHELL_SYNTAX.test(normalized)) return false
  const segments = normalized.split(CONTROL_OPERATOR).map((segment) => segment.trim()).filter(Boolean)
  if (!segments.length) return false
  return segments.every((segment) => {
    if (/^(?:\$|%|set\s)/i.test(segment)) return false
    const words = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(unquote) ?? []
    const executable = words[0]?.toLowerCase()
    if (!executable) return false
    if (SAFE_EXECUTABLES.has(executable)) return true
    if (executable === 'git') {
      const subcommand = words.find((word, index) => index > 0 && !word.startsWith('-'))
      return Boolean(subcommand && SAFE_GIT_SUBCOMMANDS.has(subcommand.toLowerCase()))
    }
    return false
  })
}
