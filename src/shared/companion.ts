import type { AgentRunEvent, AgentRunPhase, AgentRunSnapshot } from './agentRuntime'

/** A phone the user approved. */
export interface CompanionDevice {
  id: string
  name: string
  createdAt: number
  lastSeenAt: number | null
  /** The network address it last connected from. */
  lastAddress: string | null
  connected: boolean
}

/** What the desktop shows about phone access. */
export interface CompanionStatus {
  enabled: boolean
  /** Why phone access could not start, such as no local network. */
  error: string | null
  /** The address phones open, such as `http://192.168.1.20:47615`. */
  address: string | null
  /** The current QR code, while phone access is on and no pairing is in progress. */
  pairing: {
    url: string
    /** The QR code's modules, row by row; true is dark. */
    modules: boolean[][]
    expiresAt: number
  } | null
  /** A phone scanned the code and waits for the user's answer on this computer. */
  awaitingApproval: { name: string; address: string } | null
  devices: CompanionDevice[]
}

export interface CompanionChat {
  id: string
  title: string
  updatedAt: number
  pinned: boolean
  projectName: string | null
  /** The phase of the chat's latest run while it is active. */
  activePhase: AgentRunPhase | null
  /** A card in the chat waits for an answer. */
  needsAnswer: boolean
}

/** A saved message as the phone shows it; images and attachments are counted, not sent. */
export interface CompanionMessage {
  id: string
  role: string
  content: string
  timestamp: number
  runId?: string
  segments?: unknown[]
  imageCount?: number
}

export interface CompanionChatDetail {
  chat: CompanionChat
  messages: CompanionMessage[]
  /** The latest run while it is active, with its events so far. */
  run: { run: AgentRunSnapshot; events: AgentRunEvent[] } | null
}

/** The calls a paired phone can make, and what each returns. */
export interface CompanionCalls {
  'chats.list': { input: Record<string, never>; output: CompanionChat[] }
  'chat.open': { input: { conversationId: string }; output: CompanionChatDetail }
  /** Sends a message: starts a run, or hands it to the running one. No chat starts a new one. */
  'chat.send': {
    input: { conversationId?: string; text: string }
    output: { conversationId: string; runId: string | null; steered: boolean }
  }
  'run.stop': { input: { runId: string }; output: { stopped: boolean } }
  'run.events': {
    input: { runId: string; afterSequence: number }
    output: { run: AgentRunSnapshot; events: AgentRunEvent[] }
  }
  'interaction.resolve': {
    input: { interactionId: string; response: Record<string, unknown>; cancelled?: boolean }
    output: { success: true }
  }
  /** A one-time ticket for opening the event stream. */
  'events.ticket': { input: Record<string, never>; output: { ticket: string } }
}

export type CompanionCallName = keyof CompanionCalls

export const COMPANION_CALL_NAMES: readonly CompanionCallName[] = [
  'chats.list',
  'chat.open',
  'chat.send',
  'run.stop',
  'run.events',
  'interaction.resolve',
  'events.ticket'
]

export interface CompanionRequest {
  id: number
  call: CompanionCallName
  input: unknown
}

export type CompanionReply =
  | { id: number; ok: true; output: unknown }
  | { id: number; ok: false; error: string }

export type CompanionEvent =
  | { type: 'run.event'; event: AgentRunEvent }
  | { type: 'chats.changed' }
  | { type: 'messages.changed'; conversationId: string }

/** The longest message a phone may send. */
export const COMPANION_MAX_MESSAGE_LENGTH = 100_000
/** The most messages a chat sends to the phone, newest kept. */
export const COMPANION_MAX_MESSAGES = 200

/** The desktop window's controls over phone access. */
export interface CompanionAPI {
  status: () => Promise<CompanionStatus>
  /** Turns phone access on, showing a QR code, or off, closing every phone's connection. */
  setEnabled: (enabled: boolean) => Promise<CompanionStatus>
  /** Replaces the QR code with a new one. */
  newCode: () => Promise<CompanionStatus>
  /** Forgets a phone; it must scan a new code to connect again. */
  removeDevice: (deviceId: string) => Promise<CompanionStatus>
  onChanged: (callback: (status: CompanionStatus) => void) => () => void
}
