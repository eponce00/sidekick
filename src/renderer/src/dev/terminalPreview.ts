import type {
  TerminalAPI,
  TerminalSessionEvent,
  TerminalSessionSummary
} from '../../../shared/terminalSessions'

/**
 * Agent commands for the preview conversation: one finished, a dev server still printing, and
 * one stopped at a prompt, so the Terminal panel and the live command rows can be reviewed
 * without the app.
 */
export function previewTerminalApi(): TerminalAPI {
  const now = Date.now()
  const listeners = new Set<(event: TerminalSessionEvent) => void>()
  const output = new Map<string, string>()
  const sessions = new Map<string, TerminalSessionSummary>()

  const add = (session: Omit<TerminalSessionSummary, 'outputLength' | 'tail'>, text: string) => {
    output.set(session.id, text)
    sessions.set(session.id, { ...session, outputLength: text.length, tail: tailOf(text) })
  }
  const emit = (event: TerminalSessionEvent): void => {
    for (const listener of listeners) listener(event)
  }
  const append = (id: string, data: string): void => {
    const session = sessions.get(id)
    if (!session) return
    const offset = session.outputLength
    const text = (output.get(id) ?? '') + data
    output.set(id, text)
    session.outputLength = text.length
    session.tail = tailOf(text)
    emit({ type: 'output', id, offset, data })
    emit({ type: 'session', session: { ...session } })
  }
  const end = (id: string, state: TerminalSessionSummary['state'], exitCode?: number): void => {
    const session = sessions.get(id)
    if (!session) return
    session.state = state
    session.exitCode = exitCode
    session.endedAt = Date.now()
    emit({ type: 'session', session: { ...session } })
  }

  add(
    {
      id: 'preview-tool-command',
      runId: 'preview-run-1',
      conversationId: 'preview-1',
      toolCallId: 'preview-tool-command',
      title: 'Check the renderer',
      command: 'npm run typecheck:web',
      cwd: 'C:\\Projects\\sidekick',
      background: false,
      pty: true,
      state: 'exited',
      exitCode: 0,
      startedAt: now - 130_000,
      endedAt: now - 126_000
    },
    '\r\n> sidekick@0.6.0 typecheck:web\r\n> tsc --noEmit -p tsconfig.web.json --composite false\r\n\r\n\u001b[32mType check passed.\u001b[0m\r\n'
  )
  add(
    {
      id: 'preview-dev-server',
      runId: 'preview-run-1',
      conversationId: 'preview-1',
      toolCallId: 'preview-tool-dev-server',
      title: 'Start the dev server',
      command: 'npm run dev',
      cwd: 'C:\\Projects\\sidekick',
      background: true,
      pty: true,
      state: 'running',
      startedAt: now - 90_000
    },
    '\r\n> sidekick@0.6.0 dev\r\n> vite\r\n\r\n  \u001b[1m\u001b[32mVITE\u001b[0m v7.1.3  ready in \u001b[1m412\u001b[0m ms\r\n\r\n  \u001b[32m➜\u001b[0m  \u001b[1mLocal\u001b[0m:   \u001b[36mhttp://localhost:5173/\u001b[0m\r\n  \u001b[2m➜  Network: use --host to expose\u001b[0m\r\n'
  )
  add(
    {
      id: 'preview-scaffold',
      runId: 'preview-run-1',
      conversationId: 'preview-1',
      title: 'Scaffold the docs site',
      command: 'npx create-vite docs --template react-ts',
      cwd: 'C:\\Projects\\sidekick',
      background: true,
      pty: true,
      state: 'waiting_for_input',
      startedAt: now - 20_000
    },
    'Need to install the following packages:\r\ncreate-vite@7.1.0\r\nOk to proceed? (y) '
  )

  let ticks = 0
  const timer = window.setInterval(() => {
    ticks += 1
    const time = new Date().toLocaleTimeString()
    append(
      'preview-dev-server',
      `\u001b[2m${time}\u001b[0m \u001b[36m[vite]\u001b[0m hmr update /src/components/ChatPanel.tsx${ticks % 3 === 0 ? ', /src/components/ChatPanel.css' : ''}\r\n`
    )
  }, 4_000)
  window.addEventListener('beforeunload', () => window.clearInterval(timer))

  return {
    list: async (conversationId) =>
      [...sessions.values()]
        .filter((session) => session.conversationId === conversationId)
        .map((session) => ({ ...session })),
    read: async (id, offset = 0) => {
      const text = output.get(id)
      return text === undefined
        ? null
        : { id, offset, data: text.slice(offset), truncatedBefore: false }
    },
    stop: async (id) => {
      const live = sessions.get(id)
      if (!live || (live.state !== 'running' && live.state !== 'waiting_for_input')) {
        return { stopped: false }
      }
      append(id, '^C\r\n')
      end(id, 'stopped', -1)
      return { stopped: true }
    },
    moveToBackground: async (id) => {
      const session = sessions.get(id)
      if (!session || session.background) return { moved: false }
      session.background = true
      emit({ type: 'session', session: { ...session } })
      return { moved: true }
    },
    write: async (id, data) => {
      const session = sessions.get(id)
      if (!session || (session.state !== 'running' && session.state !== 'waiting_for_input')) {
        return { written: false }
      }
      append(id, data.replace(/\r/g, '\r\n'))
      if (id === 'preview-scaffold' && /\r|\n/.test(data)) {
        session.state = 'running'
        append(id, '\r\nScaffolding project in C:\\Projects\\sidekick\\docs...\r\n\r\nDone.\r\n')
        end(id, 'exited', 0)
      }
      return { written: true }
    },
    onEvent: (callback) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    }
  }
}

function tailOf(text: string): string[] {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*m/g, '')
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line, index, lines) => line || index < lines.length - 1)
      .slice(-6)
  )
}
