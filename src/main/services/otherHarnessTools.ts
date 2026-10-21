interface EquivalentGroup {
  /** Tool names in other harnesses, in lowercase letters and digits only. */
  names: readonly string[]
  /** SideKick tools that do the same job, in order of preference. */
  tools: readonly string[]
  /** How the SideKick tool covers the job when its name does not say so. */
  how?: string
}

const EXACT_EDIT = ['Edit', 'search_replace', 'edit']

/**
 * Tools that models know from other agent harnesses (Claude Code, Codex, OpenCode, Gemini CLI,
 * Cline, Cursor). A call to one is still refused, because the arguments differ, but the refusal
 * names the SideKick tool to call instead of only saying the name is unknown.
 */
const GROUPS: readonly EquivalentGroup[] = [
  { names: ['applypatch', 'patch'], tools: ['apply_patch', ...EXACT_EDIT] },
  {
    names: [
      'edit',
      'multiedit',
      'editfile',
      'replace',
      'replaceinfile',
      'searchreplace',
      'strreplace',
      'strreplacebasededittool'
    ],
    tools: [...EXACT_EDIT, 'apply_patch']
  },
  {
    names: ['write', 'writefile', 'writetofile', 'createfile'],
    tools: ['Write', 'write', 'apply_patch']
  },
  { names: ['deletefile'], tools: ['delete_file', 'apply_patch'] },
  { names: ['read', 'readfile', 'readmanyfiles', 'view'], tools: ['read'] },
  {
    names: ['ls', 'list', 'listdir', 'listdirectory', 'listfiles', 'glob', 'filesearch'],
    tools: ['read'],
    how: 'with a directory path, and glob for a pattern such as **/*.ts'
  },
  {
    names: ['grep', 'grepsearch', 'searchfilecontent', 'searchfiles', 'codebasesearch', 'ripgrep'],
    tools: ['shell'],
    how: 'to run rg (Select-String in Windows PowerShell)'
  },
  {
    names: [
      'bash',
      'exec',
      'execcommand',
      'localshell',
      'containerexec',
      'runshellcommand',
      'runterminalcmd',
      'executecommand',
      'runcommand',
      'terminal'
    ],
    tools: ['shell']
  },
  { names: ['writestdin'], tools: ['send_command_input'] },
  { names: ['bashoutput'], tools: ['read_command_output'] },
  { names: ['killshell', 'killbash'], tools: ['cancel_background_task'] },
  {
    names: ['askuserquestion', 'askuser', 'askfollowupquestion', 'question', 'requestuserinput'],
    tools: ['ask_user']
  },
  {
    names: ['todowrite', 'todoread', 'writetodos', 'updateplan', 'todo'],
    tools: ['manage_todo_list']
  },
  { names: ['enterplanmode'], tools: ['enter_plan_mode'] },
  { names: ['exitplanmode'], tools: ['present_plan'] },
  {
    names: ['task', 'agent', 'dispatchagent', 'subagent', 'spawnagent'],
    tools: ['spawn_subagent']
  },
  { names: ['webfetch', 'fetch', 'fetchurl', 'readurl'], tools: ['web_fetch'] },
  { names: ['websearch', 'googlewebsearch', 'searchweb'], tools: ['web_search'] }
]

const BY_NAME = new Map(
  GROUPS.flatMap((group) => group.names.map((name): [string, EquivalentGroup] => [name, group]))
)

export interface OtherHarnessEquivalent {
  tool: string
  how?: string
}

/** The SideKick tool in this run that does what another harness's tool of this name does. */
export function otherHarnessEquivalent(
  name: string,
  available: ReadonlySet<string>
): OtherHarnessEquivalent | null {
  const group = BY_NAME.get(name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase())
  const tool = group?.tools.find((candidate) => available.has(candidate))
  if (!group || !tool) return null
  return { tool, ...(group.how ? { how: group.how } : {}) }
}
