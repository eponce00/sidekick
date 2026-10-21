/**
 * The credentials the user stores for SideKick's agent. Each entry, its values and its scope
 * together, is one record sealed with the operating system's protected storage, so editing the
 * store file cannot widen where a value may go or swap the value without the OS key. Values leave
 * this service only through `resolve`, for main-process code that is about to use one, and to the
 * redactor; summaries for the renderer and the agent never carry them.
 */
import { randomUUID } from 'crypto'
import {
  credentialWidening,
  defaultCredentialScope,
  type CredentialEvent,
  type CredentialEventKind,
  type CredentialSaveInput,
  type CredentialScope,
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
  entries: Record<string, StoredEntry>
}

export interface CredentialPersistence {
  read(): unknown
  write(file: VaultFile): void
  readEvents(): unknown
  writeEvents(events: CredentialEvent[]): void
}

/** The sealed part of an entry. */
interface SealedRecord {
  id: string
  alias: string
  kind: CredentialSummary['kind']
  description: string
  usernameVisible: boolean
  ask: CredentialSummary['ask']
  scope: CredentialScope
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readFile(value: unknown): VaultFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.entries)) {
    return { version: 1, entries: {} }
  }
  const entries: Record<string, StoredEntry> = {}
  for (const [id, raw] of Object.entries(value.entries)) {
    if (!isRecord(raw)) continue
    if (
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
    }
  }
  return { version: 1, entries }
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
  private loaded = false

  constructor(
    private readonly cipher: CredentialCipher,
    private readonly persistence: CredentialPersistence,
    private readonly redactor: CredentialRedactor = credentialRedactor,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = randomUUID
  ) {}

  status(): CredentialStatus {
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
                usernameVisible: false,
                ask: 'every_use',
                scope: defaultCredentialScope(),
                values: {},
                createdAt: 0,
                updatedAt: 0
              }
            }
      )
    }
    this.entries = entries
    this.loaded = true
    this.refreshRedactor()
  }

  private ensureLoaded(): void {
    if (!this.loaded) this.load()
  }

  private refreshRedactor(): void {
    const current = [...this.entries.values()].flatMap(({ record }) =>
      Object.values(record.values)
        .filter((value): value is string => typeof value === 'string' && Boolean(value))
        .map((value) => ({ alias: record.alias, value }))
    )
    this.redactor.setSecrets([...current, ...this.retired])
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
      usernameVisible: record.usernameVisible,
      ...(record.usernameVisible && record.values.username
        ? { username: record.values.username }
        : {}),
      ask: record.ask,
      scope: record.scope,
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

  /** How saving `input` would let the agent use an existing entry more than it can now. */
  widening(input: CredentialSaveInput): string[] {
    this.ensureLoaded()
    const existing = input.id ? this.entries.get(input.id) : undefined
    if (!existing || existing.needsValue) return []
    return credentialWidening(existing.record, input)
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
    const now = this.now()
    const id = existing?.record.id ?? this.newId()
    const previousValues =
      existing && !existing.needsValue && existing.record.kind === input.kind
        ? existing.record.values
        : {}
    const values: CredentialValues = { ...previousValues, ...(input.values ?? {}) }
    const fields = input.kind === 'secret' ? ['secret'] : ['username', 'password']
    for (const field of Object.keys(values) as Array<keyof CredentialValues>) {
      if (!fields.includes(field)) delete values[field]
    }
    if (fields.some((field) => !values[field as keyof CredentialValues])) {
      throw new Error('Enter every value for this credential.')
    }
    const record: SealedRecord = {
      id,
      alias: input.alias,
      kind: input.kind,
      description: input.description,
      usernameVisible: input.kind === 'sign_in' && input.usernameVisible,
      ask: input.ask,
      scope: input.scope,
      values,
      createdAt: existing && !existing.needsValue ? existing.record.createdAt : now,
      updatedAt: now
    }
    const file = readFile(this.persistence.read())
    file.entries[id] = {
      alias: record.alias,
      kind: record.kind,
      description: record.description,
      sealed: this.cipher.seal(JSON.stringify(record))
    }
    this.persistence.write(file)

    const replaced = Object.entries(previousValues).filter(
      ([field, value]) => value && values[field as keyof CredentialValues] !== value
    )
    for (const [, value] of replaced) {
      if (value) this.retired.push({ alias: existing!.record.alias, value })
    }
    this.entries.set(id, { record, needsValue: false })
    this.refreshRedactor()

    if (!existing) this.record('created', record)
    else {
      if (replaced.length || existing.needsValue) this.record('value_replaced', record)
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
    if (previous.usernameVisible !== next.usernameVisible) changes.push('username visibility')
    if (previous.ask !== next.ask) changes.push('when to ask')
    if (JSON.stringify(previous.scope) !== JSON.stringify(next.scope)) changes.push('scope')
    return changes.length ? `Changed ${changes.join(', ')}.` : undefined
  }

  delete(id: string): boolean {
    this.ensureLoaded()
    const existing = this.entries.get(id)
    if (!existing) return false
    const file = readFile(this.persistence.read())
    delete file.entries[id]
    this.persistence.write(file)
    for (const value of Object.values(existing.record.values)) {
      if (value) this.retired.push({ alias: existing.record.alias, value })
    }
    this.entries.delete(id)
    this.refreshRedactor()
    this.record('deleted', existing.record)
    return true
  }

  /**
   * An entry's values, for main-process code about to use them. The caller has already checked
   * scope and approval; nothing it returns may reach the renderer or the model.
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
