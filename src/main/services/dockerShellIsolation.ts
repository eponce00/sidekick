import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpath, lstat } from 'node:fs/promises'
import { relative, isAbsolute, sep, basename, dirname, join, resolve } from 'node:path'
import type { WorkspaceFolder } from '../../shared/projects'

const exec = promisify(execFile)
export const SHELL_SANDBOX_IMAGE =
  'node@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e'

/**
 * Where each project folder appears in the container. A project of one folder is mounted at
 * /workspace. With more folders, each one is mounted at /workspace/<name>, the primary under a
 * name of its own; a folder mounted inside another's bind mount would make Docker create an empty
 * folder for it on the host.
 */
export function sandboxFolderMounts(
  primaryRoot: string,
  folders: readonly WorkspaceFolder[]
): Array<{ root: string; target: string }> {
  if (!folders.length) return [{ root: primaryRoot, target: '/workspace' }]
  const taken = new Set(folders.map(({ name }) => name.toLowerCase()))
  let primaryName = basename(primaryRoot)
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^\.+/, '')
  primaryName ||= 'main'
  for (let number = 2; taken.has(primaryName.toLowerCase()); number++) {
    primaryName = `${primaryName.replace(/-\d+$/, '')}-${number}`
  }
  return [
    { root: primaryRoot, target: `/workspace/${primaryName}` },
    ...folders.map(({ name, path }) => ({ root: path, target: `/workspace/${name}` }))
  ]
}

export async function isolatedShellProcess(input: {
  id: string
  workspaceRoot: string
  /** The project's other folders; each is mounted beside the primary one. */
  folders?: readonly WorkspaceFolder[]
  cwd: string
  command: string
  timeoutSecs?: number
  env: NodeJS.ProcessEnv
  /**
   * Variables in `env` holding stored credentials. Each is passed into the container by name, so
   * Docker reads its value from its own environment and the value never appears on its command line.
   */
  secretNames?: readonly string[]
  /** Trusted app configuration only; never derive a mount from ambient shell variables. */
  skillAssetsPath?: string
}): Promise<{ file: string; args: string[]; cleanup: () => Promise<void> }> {
  if (!/^[a-zA-Z0-9-]+$/.test(input.id)) throw new Error('Invalid isolated command identity')
  const runDocker = (args: string[]) =>
    exec('docker', args, {
      env: input.env,
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 1024 * 1024
    })
  if (input.env.DOCKER_HOST && input.env.DOCKER_CONTEXT)
    throw new Error('Ambiguous Docker endpoint overrides; select one local Docker context')
  const endpoint =
    input.env.DOCKER_HOST ||
    (
      await runDocker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])
    ).stdout.trim()
  if (!endpoint.startsWith('npipe://') && !endpoint.startsWith('unix://'))
    throw new Error('Shell isolation requires a local Docker daemon')
  if ((await runDocker(['info', '--format', '{{.OSType}}'])).stdout.trim() !== 'linux')
    throw new Error('Shell isolation requires Linux containers')
  try {
    await runDocker(['image', 'inspect', SHELL_SANDBOX_IMAGE])
  } catch {
    throw new Error(
      `Sandbox image is missing. Install it explicitly: docker pull ${SHELL_SANDBOX_IMAGE}`
    )
  }
  const root = await realpath(input.workspaceRoot)
  const cwd = await realpath(input.cwd)
  const mounts = await Promise.all(
    sandboxFolderMounts(root, input.folders ?? []).map(async (mount) => {
      if (
        !/^\/workspace(?:\/[A-Za-z0-9._ -]+)?$/.test(mount.target) ||
        /\/\.\.?$/.test(mount.target)
      )
        throw new Error('Invalid sandbox folder name')
      const real = await realpath(mount.root)
      if (/[\r\n,]/.test(real))
        throw new Error('Sandbox mount path cannot contain commas or newlines')
      return { ...mount, root: real }
    })
  )
  const home = mounts
    .map((mount) => ({ mount, child: relative(mount.root, cwd) }))
    .find(({ child }) => !(child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)))
  if (!home) throw new Error('Sandbox cwd escapes the project')
  const workdir = [home.mount.target, ...home.child.split(sep).filter(Boolean)].join('/')
  const helperArgs: string[] = []
  if (input.skillAssetsPath) {
    if (!isAbsolute(input.skillAssetsPath) || /[\r\n,"\0]/.test(input.skillAssetsPath))
      throw new Error('Invalid bundled helper mount path')
    const assets = await realpath(input.skillAssetsPath)
    if (
      /[\r\n,"\0]/.test(assets) ||
      basename(assets).toLowerCase() !== 'skills' ||
      basename(dirname(assets)).toLowerCase() !== 'resources' ||
      mounts.some((mount) => resolve(assets) === resolve(mount.root))
    )
      throw new Error('Bundled helper mount must be the configured resources/skills directory')
    const directory = await lstat(input.skillAssetsPath)
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error('Bundled helper mount must be a real directory')
    for (const name of ['preflight.py', 'office/validate.py']) {
      const marker = await lstat(join(assets, name))
      if (!marker.isFile() || marker.isSymbolicLink())
        throw new Error('Bundled helper directory is incomplete or linked')
      const located = relative(assets, await realpath(join(assets, name)))
      if (located === '..' || located.startsWith(`..${sep}`) || isAbsolute(located))
        throw new Error('Bundled helper asset escapes its directory')
    }
    helperArgs.push(
      '--mount',
      `type=bind,src=${assets},dst=/sidekick-skills,readonly,bind-recursive=disabled`,
      '--env',
      'SIDEKICK_SKILLS=/sidekick-skills'
    )
  }
  const secretArgs: string[] = []
  for (const name of input.secretNames ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || input.env[name] === undefined) {
      throw new Error('Invalid credential variable for the isolated shell')
    }
    secretArgs.push('--env', name)
  }
  const name = `sidekick-shell-${input.id}`
  return {
    file: 'docker',
    args: [
      'run',
      '--rm',
      '--pull=never',
      '--name',
      name,
      '--label',
      'sidekick.role=isolated-shell',
      '--init',
      '--read-only',
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '128',
      '--memory',
      '2g',
      '--cpus',
      '2',
      '--user',
      `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`,
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,size=268435456',
      ...mounts.flatMap((mount) => [
        '--mount',
        `type=bind,src=${mount.root},dst=${mount.target},bind-recursive=disabled`
      ]),
      ...helperArgs,
      '--workdir',
      workdir,
      '--env',
      'HOME=/tmp',
      ...secretArgs,
      '--entrypoint',
      '/usr/bin/timeout',
      SHELL_SANDBOX_IMAGE,
      '--signal=TERM',
      '--kill-after=3s',
      `${Math.max(1, Math.min(86400, input.timeoutSecs ?? 30))}s`,
      '/bin/sh',
      '-c',
      input.command
    ],
    cleanup: async () => {
      for (let attempt = 0; attempt < 10; attempt++) {
        // --rm and the independent container deadline can race explicit cancellation.
        await runDocker(['rm', '--force', name]).catch(() => undefined)
        const remaining = await runDocker(['ps', '-aq', '--filter', `name=^/${name}$`])
        if (!remaining.stdout.trim()) return
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error('Could not confirm sandbox cleanup; inspect Docker before retrying')
    }
  }
}
