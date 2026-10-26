/**
 * The credentials the user stores for SideKick's agent. Each entry, its values and its description
 * together, is one record sealed with the operating system's protected storage, so editing the
 * store file cannot swap a value or rename an entry without the OS key. Values leave
 * this service only through `resolve`, for main-process code that is about to use one, and to the
 * redactor; summaries for the renderer and the agent never carry them.
 */
import { randomUUID } from 'crypto'
import {
  type CredentialEvent,
  type CredentialEventKind,
  type CredentialSaveInput,
  type CredentialStatus,
  type CredentialSummary,
  type CredentialValues
} from '../../shared/credentials'
import { credentialRedactor, type CredentialRedactor } from './credentialRedaction'

export interface CredentialCipher {
  isAvailable(): boolean
  /** Returns the sealed text, encoded for JSON storage. */
  seal(plaintext: string): string
  open(sealed: string): string
}

/** What the store keeps per entry: enough to list it when this computer cannot open the seal. */
interface StoredEntry {
  alias: string
  kind: CredentialSummary['kind']
  description: string
  sealed: string
}

interface VaultFile {
  version: 1
  /** Entries this version cannot read are written back exactly as they were. */
  entries: Record<string, StoredEntry | unknown>
}

/** The store as read: the entries this version understands, and whether it may write it. */
interface ReadVault {
  entries: Record<string, StoredEntry>
  unknown: Record<string, unknown>
  /** Written by a newer SideKick, or not a store at all: saving would destroy what it holds. */
  locked: boolean
}

export interface CredentialPersistence {
  read(): unknown
  write(file: VaultFile): void
  readEvents(): unknown
  writeEvents(events: CredentialEvent[]): void
}

/**
 * The sealed part of an entry. Records from before credentials followed the permission mode also
 * hold the scope and approval settings they had; nothing reads those, and saving drops them.
 */
interface SealedRecord {
  /** The record's layout, so a later version can migrate it when a default changes. */
  schema?: 1
  id: string
  alias: string
  kind: CredentialSummary['kind']
  description: string
  values: CredentialValues
  createdAt: number
  updatedAt: number
}

interface OpenEntry {
  record: SealedRecord
  needsValue: boolean
}

/** A credential with its values, for main-process code that is about to use it. */
export interface ResolvedCredential {
  summary: CredentialSummary
  values: CredentialValues
}

export class CredentialUnavailableError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'CredentialUnavailableError'
  }
}

const MAX_EVENTS = 1_000
const UNAVAILABLE_REASON =
  "This computer has no protected storage SideKick can use, such as the system keychain, so credentials can't be stored safely."
const LOCKED_REASON =
  'Stored credentials were saved by a newer version of SideKick, or the store cannot be read. Update SideKick to change them; nothing was changed.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readFile(value: unknown): ReadVault {
  if (value === undefined || value === null) return { entries: {}, unknown: {}, locked: false }
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.entries)) {
    return { entries: {}, unknown: {}, locked: true }
  }
  const entries: Record<string, StoredEntry> = {}
  const unknown: Record<string, unknown> = {}
  for (const [id, raw] of Object.entries(value.entries)) {
    if (
      isRecord(raw) &&
      typeof raw.alias === 'string' &&
      (raw.kind === 'secret' || raw.kind === 'sign_in') &&
      typeof raw.description === 'string' &&
      typeof raw.sealed === 'string'
    ) {
      entries[id] = {
        alias: raw.alias,
        kind: raw.kind,
        description: raw.description,
        sealed: raw.sealed
      }
    } else unknown[id] = raw
  }
  return { entries, unknown, locked: false }
}

/** The values the redactor hides: every value but a username, which the agent may read. */
function hiddenValues(record: SealedRecord): Array<[keyof CredentialValues, string]> {
  return (Object.entries(record.values) as Array<[keyof CredentialValues, unknown]>).filter(
    (entry): entry is [keyof CredentialValues, string] =>
      typeof entry[1] === 'string' && Boolean(entry[1]) && entry[0] !== 'username'
  )
}

function readEvents(value: unknown): CredentialEvent[] {
  return Array.isArray(value)
    ? value.filter(
        (event): event is CredentialEvent =>
          isRecord(event) &&
          typeof event.id === 'string' &&
          typeof event.credentialId === 'string' &&
          typeof event.alias === 'string' &&
          typeof event.kind === 'string' &&
          typeof event.at === 'number'
      )
    : []
}

function parseSealed(id: string, text: string): SealedRecord | null {
  try {
    const value = JSON.parse(text) as unknown
    if (!isRecord(value) || value.id !== id || !isRecord(value.values)) return null
    return value as unknown as SealedRecord
  } catch {
    return null
  }
}

export class CredentialVault {
  private entries = new Map<string, OpenEntry>()
  /** Values replaced or deleted since launch stay redacted until SideKick restarts. */
  private readonly retired: Array<{ alias: string; value: string }> = []
  /** Values that exist only in memory, such as tokens a request returned; redacted the same way. */
  private transient: Array<{ alias: string; value: string }> = []
  private loaded = false
  private locked = false

  constructor(
    private readonly cipher: CredentialCipher,
    private readonly persistence: CredentialPersistence,
    private readonly redactor: CredentialRedactor = credentialRedactor,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = randomUUID
  ) {}

  status(): CredentialStatus {
    this.ensureLoaded()
    if (this.locked) return { available: false, reason: LOCKED_REASON }
    return this.cipher.isAvailable()
      ? { available: true }
      : { available: false, reason: UNAVAILABLE_REASON }
  }

  /** Opens every stored entry and gives the redactor their values. Safe to call again. */
  load(): void {
    const file = readFile(this.persistence.read())
    const available = this.cipher.isAvailable()
    const entries = new Map<string, OpenEntry>()
    for (const [id, stored] of Object.entries(file.entries)) {
      let record: SealedRecord | null = null
      if (available) {
        try {
          record = parseSealed(id, this.cipher.open(stored.sealed))
        } catch {
          record = null
        }
      }
      entries.set(
        id,
        record
          ? { record, needsValue: false }
          : {
              needsValue: true,
              record: {
                id,
                alias: stored.alias,
                kind: stored.kind,
                description: stored.description,
                values: {},
                createdAt: 0,
                updatedAt: 0
              }
            }
      )
    }
    this.entries = entries
    this.locked = file.locked
    this.loaded = true
    this.refreshRedactor()
  }

  private ensureLoaded(): void {
    if (!this.loaded) this.load()
  }

  private refreshRedactor(): void {
    const current = [...this.entries.values()].flatMap(({ record }) =>
      hiddenValues(record).map(([, value]) => ({ alias: record.alias, value }))
    )
    this.redactor.setSecrets([...current, ...this.retired, ...this.transient])
  }

  /** Replaces the in-memory values redacted alongside stored ones. */
  setTransientSecrets(secrets: ReadonlyArray<{ alias: string; value: string }>): void {
    this.ensureLoaded()
    this.transient = [...secrets]
    this.refreshRedactor()
  }

  /** Reads the store for a change, refusing one that would overwrite what it cannot read. */
  private writable(): ReadVault {
    const file = readFile(this.persistence.read())
    if (file.locked) throw new CredentialUnavailableError(LOCKED_REASON)
    return file
  }

  private write(file: ReadVault): void {
    this.persistence.write({ version: 1, entries: { ...file.unknown, ...file.entries } })
  }

  private lastUses(): Map<string, number> {
    const uses = new Map<string, number>()
    for (const event of readEvents(this.persistence.readEvents())) {
      if (event.kind === 'used') uses.set(event.credentialId, event.at)
    }
    return uses
  }

  private summarize({ record, needsValue }: OpenEntry, lastUsedAt?: number): CredentialSummary {
    return {
      id: record.id,
      alias: record.alias,
      kind: record.kind,
      description: record.description,
      ...(record.values.username ? { username: record.values.username } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(lastUsedAt ? { lastUsedAt } : {}),
      needsValue
    }
  }

  list(): CredentialSummary[] {
    this.ensureLoaded()
    const uses = this.lastUses()
    return [...this.entries.values()]
      .map((entry) => this.summarize(entry, uses.get(entry.record.id)))
      .sort((left, right) => left.alias.localeCompare(right.alias))
  }

  get(id: string): CredentialSummary | undefined {
    this.ensureLoaded()
    const entry = this.entries.get(id)
    return entry ? this.summarize(entry, this.lastUses().get(id)) : undefined
  }

  /** Creates or updates an entry from validated input. */
  save(input: CredentialSaveInput): CredentialSummary {
    this.ensureLoaded()
    if (!this.cipher.isAvailable()) throw new CredentialUnavailableError(UNAVAILABLE_REASON)
    const existing = input.id ? this.entries.get(input.id) : undefined
    if (input.id && !existing) throw new Error('That credential no longer exists.')
    for (const [id, entry] of this.entries) {
      if (id !== input.id && entry.record.alias === input.alias) {
        throw new Error(`Another credential is already called ${input.alias}.`)
      }
    }
    const file = this.writable()
    const now = this.now()
    const id = existing?.record.id ?? this.newId()
    const oldValues = existing && !existing.needsValue ? existing.record.values : {}
    // A changed kind keeps no value; every old one is replaced.
    const previousValues = existing?.record.kind === input.kind ? oldValues : {}
    const values: CredentialValues = { ...previousValues, ...(input.values ?? {}) }
    const fields = input.kind === 'secret' ? ['secret'] : ['username', 'password']
    for (const field of Object.keys(values) as Array<keyof CredentialValues>) {
      if (!fields.includes(field)) delete values[field]
    }
    if (fields.some((field) => !values[field as keyof CredentialValues])) {
      throw new Error('Enter every value for this credential.')
    }
    const record: SealedRecord = {
      schema: 1,
      id,
      alias: input.alias,
      kind: input.kind,
      description: input.description,
      values,
      createdAt: existing && !existing.needsValue ? existing.record.createdAt : now,
      updatedAt: now
    }
    file.entries[id] = {
      alias: record.alias,
      kind: record.kind,
      description: record.description,
      sealed: this.cipher.seal(JSON.stringify(record))
    }
    this.write(file)

    const replaced = existing
      ? hiddenValues({ ...existing.record, values: oldValues }).filter(
          ([field, value]) => values[field] !== value
        )
      : []
    for (const [, value] of replaced) this.retired.push({ alias: existing!.record.alias, value })
    this.entries.set(id, { record, needsValue: false })
    this.refreshRedactor()

    if (!existing) this.record('created', record)
    else {
      const replacedAny = Object.entries(oldValues).some(
        ([field, value]) =>
          field !== 'username' && value && values[field as keyof CredentialValues] !== value
      )
      if (replacedAny || existing.needsValue) this.record('value_replaced', record)
      const changes = this.describeChanges(existing.record, record)
      if (changes) this.record('changed', record, { detail: changes })
    }
    return this.summarize({ record, needsValue: false }, this.lastUses().get(id))
  }

  private describeChanges(previous: SealedRecord, next: SealedRecord): string | undefined {
    const changes: string[] = []
    if (previous.alias !== next.alias) changes.push(`alias was ${previous.alias}`)
    if (previous.kind !== next.kind) changes.push('kind')
    if (previous.description !== next.description) changes.push('description')
    if (previous.values.username !== next.values.username) changes.push('username')
    return changes.length ? `Changed ${changes.join(', ')}.` : undefined
  }

  delete(id: string): boolean {
    this.ensureLoaded()
    const existing = this.entries.get(id)
    if (!existing) return false
    const file = this.writable()
    delete file.entries[id]
    this.write(file)
    for (const [, value] of hiddenValues(existing.record)) {
      this.retired.push({ alias: existing.record.alias, value })
    }
    this.entries.delete(id)
    this.refreshRedactor()
    this.record('deleted', existing.record)
    return true
  }

  /**
   * An entry's values, for main-process code about to use them. The caller has already checked
   * approval; nothing it returns may reach the renderer or the model.
   */
  resolve(alias: string): ResolvedCredential | undefined {
    this.ensureLoaded()
    for (const entry of this.entries.values()) {
      if (entry.record.alias !== alias || entry.needsValue) continue
      return {
        summary: this.summarize(entry, this.lastUses().get(entry.record.id)),
        values: { ...entry.record.values }
      }
    }
    return undefined
  }

  /** Records one audit event; it never holds a value. */
  record(
    kind: CredentialEventKind,
    entry: Pick<SealedRecord, 'id' | 'alias'>,
    details: Partial<
      Pick<CredentialEvent, 'tool' | 'target' | 'conversationId' | 'runId' | 'detail'>
    > = {}
  ): CredentialEvent {
    const event: CredentialEvent = {
      id: this.newId(),
      credentialId: entry.id,
      alias: entry.alias,
      kind,
      at: this.now(),
      ...Object.fromEntries(
        Object.entries(details).filter(([, value]) => typeof value === 'string' && value)
      )
    }
    const events = readEvents(this.persistence.readEvents())
    events.push(event)
    this.persistence.writeEvents(events.slice(-MAX_EVENTS))
    return event
  }

  /** Newest first, for one entry or for all of them. */
  events(credentialId?: string): CredentialEvent[] {
    return readEvents(this.persistence.readEvents())
      .filter((event) => !credentialId || event.credentialId === credentialId)
      .reverse()
  }
}
