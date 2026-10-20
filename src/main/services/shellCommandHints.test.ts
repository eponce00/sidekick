import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { delimiter, join } from 'path'
import {
  nestedPowerShellHint,
  ripgrepOnPath,
  shellCommandHint,
  unixCommandHint
} from './shellCommandHints'

/** What Windows PowerShell 5.1 prints for a command it does not have. */
function notRecognized(name: string, line: string): string {
  return [
    `${name} : The term '${name}' is not recognized as the name of a cmdlet, function, script file, or operable program. Check the`,
    'spelling of the name, or if a path was included, verify that the path is correct and try again.',
    'At line:1 char:1',
    `+ ${line}`,
    '+ ~~~~',
    `    + CategoryInfo          : ObjectNotFound: (${name}:String) [], CommandNotFoundException`,
    '    + FullyQualifiedErrorId : CommandNotFoundException'
  ].join('\r\n')
}

/** What it prints for a Unix flag on one of its aliases. */
function flagRefused(flag: string, cmdlet: string, command: string): string {
  return [
    `${cmdlet.replace('Command', '').replace(/^Get/, 'Get-')} : A parameter cannot be found that matches parameter name '${flag}'.`,
    'At line:1 char:5',
    `+ ${command}`,
    '    + CategoryInfo          : InvalidArgument: (:) [], ParameterBindingException',
    `    + FullyQualifiedErrorId : NamedParameterNotFound,Microsoft.PowerShell.Commands.${cmdlet}`
  ].join('\r\n')
}

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('unixCommandHint', () => {
  it('names Select-String, or rg when it is installed, for grep', () => {
    const output = notRecognized('grep', 'grep -rn "TODO" src')
    const withRg = unixCommandHint('grep -rn "TODO" src', output, 'win32', () => true)
    expect(withRg).toContain('Windows PowerShell, not Bash')
    expect(withRg).toContain('Instead of `grep`, use `rg <regex> <path>`')
    expect(withRg).toContain('Select-String')
    const withoutRg = unixCommandHint('grep -rn "TODO" src', output, 'win32', () => false)
    expect(withoutRg).toContain('Instead of `grep`, use `Select-String -Pattern')
    expect(withoutRg).not.toContain('rg ')
  })

  it.each([
    ['head', 'Get-Content src/a.ts | head -20', '-TotalCount'],
    ['tail', 'tail -n 50 build.log', '-Tail'],
    ['which', 'which node', 'Get-Command'],
    ['wc', 'wc -l src/a.ts', 'Measure-Object -Line'],
    ['egrep', 'egrep "a|b" src/a.ts', 'Select-String']
  ])('names the PowerShell equivalent of %s', (name, command, equivalent) => {
    const hint = unixCommandHint(command, notRecognized(name, command), 'win32', () => false)
    expect(hint).toContain(`Instead of \`${name}\``)
    expect(hint).toContain(equivalent)
  })

  it('reads the command name from the error id, which PowerShell never translates', () => {
    const german = [
      'grep : Die Benennung "grep" wurde nicht als Name eines Cmdlet, einer Funktion, einer Skriptdatei oder eines',
      'ausführbaren Programms erkannt.',
      '    + CategoryInfo          : ObjectNotFound: (grep:String) [], CommandNotFoundException',
      '    + FullyQualifiedErrorId : CommandNotFoundException'
    ].join('\r\n')
    expect(unixCommandHint('grep x', german, 'win32', () => false)).toContain('Instead of `grep`')
  })

  it('explains a Unix flag on cat and ls, which are PowerShell aliases', () => {
    const cat = unixCommandHint(
      'cat -n src/a.ts',
      flagRefused('n', 'GetContentCommand', 'cat -n src/a.ts'),
      'win32'
    )
    expect(cat).toContain('Instead of `cat`, use `Get-Content <file>`, which has no -n')
    expect(cat).toContain('read tool')
    const ls = unixCommandHint(
      'ls -la',
      flagRefused('la', 'GetChildItemCommand', 'ls -la'),
      'win32'
    )
    expect(ls).toContain('Instead of `ls`, use `Get-ChildItem -Force`')
    // Only the alias whose cmdlet refused the flag is named.
    expect(
      unixCommandHint(
        'cat -n a.ts; ls -Force',
        flagRefused('n', 'GetContentCommand', 'cat -n a.ts'),
        'win32'
      )
    ).not.toContain('`ls`')
  })

  it('names each Unix command once, in the order they failed', () => {
    const output = `${notRecognized('grep', 'grep x')}\r\n${notRecognized('head', 'head -5')}`
    const hint = unixCommandHint('grep x a.ts | head -5', output, 'win32', () => false)!
    expect(hint.match(/Instead of `grep`/g)).toHaveLength(1)
    expect(hint.indexOf('`grep`')).toBeLessThan(hint.indexOf('`head`'))
  })

  it('stays quiet for other failures and other platforms', () => {
    expect(
      unixCommandHint('frobnicate', notRecognized('frobnicate', 'frobnicate'), 'win32')
    ).toBeNull()
    expect(unixCommandHint('npm test', 'Test failed: expected 1 to be 2', 'win32')).toBeNull()
    expect(
      unixCommandHint('Get-Content a.ts -Raw', flagRefused('x', 'GetContentCommand', ''), 'win32')
    ).toBeNull()
    expect(unixCommandHint('grep x', notRecognized('grep', 'grep x'), 'linux')).toBeNull()
  })

  it('prefers the nested PowerShell hint, which explains the whole command', () => {
    const command = 'powershell -Command "grep x"'
    expect(shellCommandHint(command, notRecognized('grep', 'grep x'), 'win32')).toContain(
      'Run the PowerShell directly'
    )
  })
})

describe('ripgrepOnPath', () => {
  it('finds rg only in a directory on the PATH', async () => {
    const withRg = await mkdtemp(join(tmpdir(), 'sidekick-rg-'))
    const without = await mkdtemp(join(tmpdir(), 'sidekick-no-rg-'))
    directories.push(withRg, without)
    await writeFile(join(withRg, process.platform === 'win32' ? 'rg.exe' : 'rg'), '')
    expect(ripgrepOnPath([without, withRg].join(delimiter))).toBe(true)
    expect(ripgrepOnPath(['', without].join(delimiter))).toBe(false)
  })
})

describe('nestedPowerShellHint', () => {
  it('names the nested PowerShell wrapper on Windows', () => {
    for (const command of [
      `powershell -Command "Get-PnPDevice | Where-Object { $_.FriendlyName -like '*Logi*' }"`,
      `powershell.exe -NoProfile -c 'Get-Service logi*'`,
      `pwsh -NoLogo -Command "Get-Process"`,
      String.raw`Set-Location C:\x; & "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command "dir"`
    ]) {
      expect(nestedPowerShellHint(command, 'win32'), command).toContain(
        'Run the PowerShell directly'
      )
    }
  })

  it('leaves direct PowerShell, script files, and other platforms alone', () => {
    for (const command of [
      `Get-PnPDevice | Where-Object { $_.FriendlyName -like '*Logi*' }`,
      String.raw`powershell -File .\scripts\build.ps1`,
      'npm run build -- --config powershell-compatible.json',
      'Write-Output "use pwsh -Command for PowerShell 7"'
    ]) {
      expect(nestedPowerShellHint(command, 'win32'), command).toBeNull()
    }
    expect(nestedPowerShellHint('powershell -Command "dir"', 'linux')).toBeNull()
  })
})
