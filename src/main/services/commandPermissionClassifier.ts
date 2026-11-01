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

/** Options that make an otherwise read-only program delete or write files, or run another one. */
const WRITING_OPTIONS: Record<string, RegExp> = {
  find: /^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/i,
  rg: /^--pre(?:=|$)/
}

const SAFE_GIT_SUBCOMMANDS = new Set([
  'branch',
  'diff',
  'grep',
  'log',
  'rev-parse',
  'show',
  'status'
])

const GIT_WRITING_OPTIONS: Record<string, RegExp> = {
  diff: /^--(?:output|ext-diff)(?:=|$)/,
  log: /^--(?:output|ext-diff)(?:=|$)/,
  show: /^--(?:output|ext-diff)(?:=|$)/,
  // `-O` opens the matching files in a program of the caller's choice.
  grep: /^(?:-[^-]*O|--open-files-in-pager)/
}

/** `git branch` options that only change how branches are listed. */
const BRANCH_LIST_FLAG =
  /^(?:-[arvil]+|--(?:all|remotes|verbose|show-current|list|ignore-case|omit-empty|no-color|no-column|no-abbrev)|--(?:color|column|abbrev|sort|format|contains|no-contains|merged|no-merged|points-at)=.*)$/
/** Listing options that take the next word as their value. */
const BRANCH_LIST_OPTION_WITH_VALUE =
  /^--(?:sort|format|contains|no-contains|merged|no-merged|points-at)$/
/** Options after which the remaining names are patterns to list, not branches to create. */
const BRANCH_LIST_MODE =
  /^(?:-[arvi]*l[arvil]*|--list|--(?:no-)?(?:contains|merged)(?:=.*)?|--points-at(?:=.*)?)$/

/**
 * Discarding output changes nothing: `2>&1`, `2>$null`, `>/dev/null`, `*> nul`. It must end the
 * word, since Bash reads `>&1file` as a write to `1file`.
 */
const DISCARDING_REDIRECT = /^[0-9*]?>>?(?:&[0-9]|\s*(?:\$null|\/dev\/null|nul))(?=$|[\s|;&])/i

/**
 * The words of each simple command in a Bash or PowerShell command line, honoring quotes, or null
 * for anything that could run or write more than its words show: expansions and subexpressions,
 * script blocks, redirections to a file, and background jobs.
 */
function simpleCommands(command: string): string[][] | null {
  // Bash reads `\'` and `\"` as plain characters, so quotes after a backslash cannot be followed
  // without knowing the shell.
  if (/\\['"]/.test(command)) return null
  const commands: string[][] = [[]]
  let word: string | null = null
  const endWord = (): void => {
    if (word !== null) commands[commands.length - 1].push(word)
    word = null
  }
  const endCommand = (): void => {
    endWord()
    commands.push([])
  }
  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    const redirect = word === null ? DISCARDING_REDIRECT.exec(command.slice(index)) : null
    if (redirect) {
      index += redirect[0].length - 1
    } else if (char === "'") {
      // Single quotes are literal in both shells.
      const close = command.indexOf("'", index + 1)
      if (close < 0) return null
      word = (word ?? '') + command.slice(index + 1, close)
      index = close
    } else if (char === '"') {
      const close = command.indexOf('"', index + 1)
      if (close < 0) return null
      const quoted = command.slice(index + 1, close)
      // Both shells still expand variables, subexpressions and backticks inside double quotes.
      if (/[$`]/.test(quoted)) return null
      word = (word ?? '') + quoted
      index = close
    } else if (char === '\n' || char === '\r' || char === ';' || char === '|') {
      endCommand()
      if (char === '|' && command[index + 1] === '|') index++
    } else if (char === '&' && command[index + 1] === '&') {
      endCommand()
      index++
    } else if (/\s/.test(char)) {
      endWord()
    } else if (/[$`(){}<>&]/.test(char)) {
      return null
    } else {
      word = (word ?? '') + char
    }
  }
  endWord()
  return commands.filter((words) => words.length)
}

function gitBranchOnlyLists(args: string[]): boolean {
  let listing = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    listing ||= BRANCH_LIST_MODE.test(arg)
    if (BRANCH_LIST_OPTION_WITH_VALUE.test(arg)) index++
    else if (!BRANCH_LIST_FLAG.test(arg) && (arg.startsWith('-') || !listing)) {
      // Any other option, or a name outside list mode, creates, moves or deletes a branch.
      return false
    }
  }
  return true
}

function gitOnlyReads(args: string[]): boolean {
  // Global options such as `-c` and `--config-env` can make any subcommand run a program.
  let index = 0
  while (args[index] === '--no-pager' || args[index] === '-P') index++
  const subcommand = args[index]
  const rest = args.slice(index + 1)
  if (!subcommand || !SAFE_GIT_SUBCOMMANDS.has(subcommand)) return false
  if (subcommand === 'branch') return gitBranchOnlyLists(rest)
  const writing = GIT_WRITING_OPTIONS[subcommand]
  return !writing || !rest.some((arg) => writing.test(arg))
}

function commandOnlyReads([first, ...args]: string[]): boolean {
  const executable = first.toLowerCase()
  if (executable === 'git') return gitOnlyReads(args)
  if (!SAFE_EXECUTABLES.has(executable)) return false
  const writing = WRITING_OPTIONS[executable]
  return !writing || !args.some((arg) => writing.test(arg))
}

/** Conservative classifier for the optional Sensitive actions mode. */
export function commandCanRunWithoutApproval(command: string): boolean {
  const commands = simpleCommands(command.trim())
  return Boolean(commands?.length && commands.every(commandOnlyReads))
}
