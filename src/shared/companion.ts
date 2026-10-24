import type { ConversationRunMode, PromptAdmissionsResult } from './agentRunApi'
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

/**
 * A saved message as the phone shows it. Its images are sent reduced, small enough for a phone;
 * its attachments by name and kind only.
 */
export interface CompanionMessage {
  id: string
  role: string
  content: string
  timestamp: number
  runId?: string
  runMode?: ConversationRunMode
  segments?: unknown[]
  images?: CompanionImage[]
  attachments?: Array<{ id: string; kind: string; name: string }>
  /** What the reply used: tokens, time and cost, for its footer. */
  tokenUsage?: Record<string, unknown>
}

/** An image as the phone shows it: a reduced copy as a data URL. */
export interface CompanionImage {
  id: string
  name: string
  mimeType: string
  dataUrl: string
}

/** A model the phone can choose for a chat. */
export interface CompanionModel {
  id: string
  name: string
  supportsVision: boolean
}

/** A file the phone sends with a message, uploaded first with `upload.put`. */
export interface CompanionUploadRef {
  uploadId: string
}

/** What the computer can do for the phone's voice buttons. */
export interface CompanionVoiceState {
  /** Dictation is installed and on; the phone streams its microphone, the computer writes it. */
  dictation: boolean
  /** Read aloud is installed and on; the computer speaks, the phone plays. */
  speech: boolean
  /** Why one is not available, in words the phone shows. */
  message: string | null
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
  /**
   * Sends a message. With no run it starts one; while one works it is queued (the default) or
   * handed to the run now (`steer`), as the desktop composer does. No chat starts a new one.
   */
  'chat.send': {
    input: {
      conversationId?: string
      text: string
      mode?: ConversationRunMode
      modelId?: string
      behavior?: 'queue' | 'steer'
      /** Uploaded images. */
      images?: CompanionUploadRef[]
      /** Uploaded text files, attached whole as the desktop attaches pasted text. */
      files?: CompanionUploadRef[]
    }
    output: { conversationId: string; runId: string | null; steered: boolean; queued: boolean }
  }
  /** The chat's queued messages and its pending steer, shared with the desktop composer. */
  'queue.list': { input: { conversationId: string }; output: PromptAdmissionsResult }
  /** Reorders, edits or removes queued messages; ids not listed are removed. */
  'queue.update': {
    input: { conversationId: string; queued: Array<{ id: string; content: string }> }
    output: PromptAdmissionsResult
  }
  /** Hands one queued message to the running run now. */
  'queue.steer': {
    input: { conversationId: string; admissionId: string }
    output: { steered: boolean }
  }
  /** The models the phone may choose, and the chat's own. */
  'models.list': {
    input: { conversationId?: string }
    output: { models: CompanionModel[]; selectedModelId: string | null }
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
  /**
   * Uploads a file in pieces of at most COMPANION_UPLOAD_CHUNK_BYTES, base64. The first piece
   * omits `uploadId` and gets one; `last` completes it. Uploads expire after ten minutes.
   */
  'upload.put': {
    input: {
      uploadId?: string
      kind: 'image' | 'text'
      name: string
      mimeType: string
      data: string
      last: boolean
    }
    output: { uploadId: string; complete: boolean }
  }
  /** An image the agent viewed or captured, by the address its tool result gives. */
  'media.get': { input: { url: string }; output: { dataUrl: string } }
  'voice.state': { input: Record<string, never>; output: CompanionVoiceState }
  /**
   * Live dictation, as the desktop's microphone does it. The phone streams its microphone in
   * `voice.dictation.audio` pieces, in order, and the words come back as `dictation.text` events:
   * drafts of the phrase being spoken, then each phrase final. After a stop, `dictation.end`
   * follows the last words.
   */
  'voice.dictation.start': {
    input: { dictationId: string }
    output: { ok: boolean; message?: string }
  }
  /** At most COMPANION_DICTATION_PIECE_SAMPLES 16 kHz mono 16-bit little-endian samples, base64. */
  'voice.dictation.audio': {
    input: { dictationId: string; pcm: string }
    output: { accepted: boolean }
  }
  'voice.dictation.stop': { input: { dictationId: string }; output: { stopped: true } }
  /** Ends dictation at once, dropping words not yet written. */
  'voice.dictation.cancel': { input: { dictationId: string }; output: { cancelled: true } }
  /** Speaks text in the computer's voice; the audio arrives as `speech.audio` events. */
  'voice.speak': {
    input: { speechId: string; text: string }
    output: { ok: boolean; message?: string }
  }
  'voice.stop': { input: { speechId: string }; output: { stopped: true } }
  /** A one-time ticket for opening the event stream. */
  'events.ticket': { input: Record<string, never>; output: { ticket: string } }
}

export type CompanionCallName = keyof CompanionCalls

export const COMPANION_CALL_NAMES: readonly CompanionCallName[] = [
  'chats.list',
  'chat.open',
  'chat.send',
  'queue.list',
  'queue.update',
  'queue.steer',
  'models.list',
  'run.stop',
  'run.events',
  'interaction.resolve',
  'upload.put',
  'media.get',
  'voice.state',
  'voice.dictation.start',
  'voice.dictation.audio',
  'voice.dictation.stop',
  'voice.dictation.cancel',
  'voice.speak',
  'voice.stop',
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
  | { type: 'queue.changed'; conversationId: string }
  /** Speech for this phone only: 16-bit little-endian mono samples, base64. */
  | { type: 'speech.audio'; speechId: string; sampleRate: number; pcm: string }
  | { type: 'speech.end'; speechId: string; error?: string }
  /** Dictation for this phone only: a draft of the phrase being spoken, or a phrase final. */
  | { type: 'dictation.text'; dictationId: string; text: string; final: boolean }
  /** A stopped dictation's last words have been sent. */
  | { type: 'dictation.end'; dictationId: string }

/** The longest message a phone may send. */
export const COMPANION_MAX_MESSAGE_LENGTH = 100_000
/** The most audio one dictation piece carries: two seconds at 16 kHz. */
export const COMPANION_DICTATION_PIECE_SAMPLES = 32_000
/** The most an upload piece carries before base64, inside the request limit. */
export const COMPANION_UPLOAD_CHUNK_BYTES = 128 * 1024
/** The most one upload may hold. Phones reduce photos before sending them. */
export const COMPANION_MAX_UPLOAD_BYTES = 20 * 1024 * 1024
/** The longest side of an image the phone is sent; the computer keeps the original. */
export const COMPANION_IMAGE_SIDE = 1600
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
