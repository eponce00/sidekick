import { describe, expect, it } from 'vitest'
import { commandCanRunWithoutApproval } from './commandPermissionClassifier'

describe('command permission classifier', () => {
  it.each([
    'Get-Content src/app.ts',
    'Select-String -Path src/app.ts -Pattern TODO',
    'rg -n permission src',
    'git status --short',
    'git diff -- src/app.ts',
    'Get-ChildItem src | Select-String test',
    'Get-Content src\\main\\index.ts',
    'rg "foo|bar" src',
    "Select-String -Path src\\app.ts -Pattern 'a(b)|$c'",
    'Select-String -Path src/app.ts -Pattern "load(Settings)"',
    "find . -name '*.ts' -print",
    'git status 2>&1',
    'git status 2>$null',
    'ls src > /dev/null',
    'git --no-pager log -5',
    "git log --format='%h %s' -5",
    'git grep -n TODO',
    'git show HEAD:README.md',
    'git status && git diff --stat'
  ])('allows inspection command %s', (command) => {
    expect(commandCanRunWithoutApproval(command)).toBe(true)
  })

  it.each([
    'git branch',
    'git branch -a',
    'git branch -vv',
    'git branch --show-current',
    'git branch --list "feature/*"',
    'git branch -l feature/*',
    'git branch --contains HEAD~1',
    'git branch -r --merged main',
    'git branch --merged=main old/*',
    "git branch --sort=-committerdate --format '%(refname:short)'"
  ])('allows listing branches with %s', (command) => {
    expect(commandCanRunWithoutApproval(command)).toBe(true)
  })

  it.each([
    'git push origin main',
    'git commit -am change',
    'Remove-Item src/app.ts',
    'npm install package',
    'Get-Content source > copy.txt',
    '$content = Get-Content src/app.ts; $content[0]'
  ])('requires approval for non-proven command %s', (command) => {
    expect(commandCanRunWithoutApproval(command)).toBe(false)
  })

  it.each([
    'git branch -D main',
    'git branch -d feature',
    'git branch -df feature',
    'git branch --delete feature',
    'git branch -m old new',
    'git branch -M main',
    'git branch -c main copy',
    'git branch -f main HEAD~3',
    'git branch new-feature',
    'git branch new-feature origin/main',
    'git branch -v new-feature',
    'git branch --set-upstream-to=origin/main',
    'git branch -u origin/main',
    'git branch --unset-upstream',
    'git branch --edit-description',
    'git branch --track topic origin/topic'
  ])('requires approval for a branch change: %s', (command) => {
    expect(commandCanRunWithoutApproval(command)).toBe(false)
  })

  it.each([
    'git -c core.pager=sh log',
    'git --config-env=core.pager=COMSPEC log',
    'git -C ../other status',
    'git --exec-path=. status',
    'git diff --output=patch.diff',
    'git log --output patch.txt',
    'git show --output=notes.txt HEAD',
    'git diff --ext-diff',
    'git grep -Ovim TODO',
    'git grep -nOsh TODO',
    'git grep --open-files-in-pager=sh TODO'
  ])('requires approval for git that can write or run a program: %s', (command) => {
    expect(commandCanRunWithoutApproval(command)).toBe(false)
  })

  it.each([
    'find . -delete',
    "find . -name '*.ts' -exec rm {} +",
    'find . -name x -exec rm {} \\;',
    'find . -execdir sh -c x',
    'find . -fprint listing.txt',
    'rg --pre sh pattern',
    'rg --pre=./run.sh pattern'
  ])('requires approval for an option that writes or runs a program: %s', (command) => {
    expect(commandCanRunWithoutApproval(command)).toBe(false)
  })

  it.each([
    'echo hi >out.txt',
    'cat a>>b',
    'echo hi >&1file',
    'ls 2>errors.txt',
    'echo $(rm -rf src)',
    'echo `rm -rf src`',
    'echo "$(rm -rf src)"',
    'echo "`rm -rf src`"',
    'cat <(rm -rf src)',
    'cat <<EOF',
    'Get-Content (Remove-Item src -Recurse)',
    'Get-ChildItem | Where-Object { Remove-Item $_ }',
    'ls & rm -rf src',
    'ls | % { rm $_ }',
    "echo \\' $(rm -rf src) \\'",
    'echo "a\\" \' $(rm -rf src) \' \\"b"',
    "Get-Content 'unterminated",
    'Get-Content "unterminated',
    'FOO=1 git status',
    'cat file | sh',
    'ls; rm -rf src',
    'ls || rm -rf src',
    'ls\nrm -rf src'
  ])('requires approval for shell syntax that can run or write more: %s', (command) => {
    expect(commandCanRunWithoutApproval(command)).toBe(false)
  })

  it('requires approval for an empty command', () => {
    expect(commandCanRunWithoutApproval('')).toBe(false)
    expect(commandCanRunWithoutApproval('  ;  ')).toBe(false)
  })
})
