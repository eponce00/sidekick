import type Database from 'better-sqlite3'
import type {
  PromptAdmissionItem,
  PromptAdmissionsResult,
  ReplacePromptAdmissionsInput
} from '../../shared/agentRunApi'
import type { MessageImageAttachment } from '../../shared/messageImages'
import type { MessageContextAttachment } from '../../shared/messageContextAttachments'

interface AdmissionRow {
  id: string
  conversation_id: string
  content: string
  images_json: string | null
  attachments_json: string | null
  mode: PromptAdmissionItem['mode']
  behavior: PromptAdmissionItem['behavior']
  position: number
  created_at: number
  updated_at: number
}

function parseImages(value: string | null): MessageImageAttachment[] | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as MessageImageAttachment[]
    return Array.isArray(parsed) && parsed.length ? parsed : undefined
  } catch {
    return undefined
  }
}

function parseAttachments(value: string | null): MessageContextAttachment[] | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as MessageContextAttachment[]
    return Array.isArray(parsed) && parsed.length ? parsed : undefined
  } catch {
    return undefined
  }
}

function toItem(row: AdmissionRow): PromptAdmissionItem {
  const images = parseImages(row.images_json)
  const attachments = parseAttachments(row.attachments_json)
  return {
    id: row.id,
    conversationId: row.conversation_id,
    content: row.content,
    ...(images ? { images } : {}),
    ...(attachments ? { attachments } : {}),
    mode: row.mode,
    behavior: row.behavior,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class PromptAdmissionStore {
  constructor(private readonly db: Database.Database) {}

  list(conversationId: string): PromptAdmissionsResult {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_prompt_admissions
         WHERE conversation_id = ?
         ORDER BY CASE behavior WHEN 'pivot' THEN 0 ELSE 1 END, position, created_at, id`
      )
      .all(conversationId) as AdmissionRow[]
    const items = rows.map(toItem)
    return {
      pivot: items.find((item) => item.behavior === 'pivot') ?? null,
      queued: items.filter((item) => item.behavior === 'queue')
    }
  }

  replace(input: ReplacePromptAdmissionsInput): PromptAdmissionsResult {
    const now = Date.now()
    this.db.transaction(() => {
      const existing = new Map(
        (
          this.db
            .prepare('SELECT id, created_at FROM agent_prompt_admissions WHERE conversation_id = ?')
            .all(input.conversationId) as Array<{ id: string; created_at: number }>
        ).map((row) => [row.id, row.created_at])
      )
      this.db
        .prepare('DELETE FROM agent_prompt_admissions WHERE conversation_id = ?')
        .run(input.conversationId)
      const insert = this.db.prepare(
        `INSERT INTO agent_prompt_admissions
          (id, conversation_id, content, images_json, attachments_json, mode, behavior, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      const write = (
        item: ReplacePromptAdmissionsInput['queued'][number],
        behavior: PromptAdmissionItem['behavior'],
        position: number
      ): void => {
        insert.run(
          item.id,
          input.conversationId,
          item.content,
          item.images?.length ? JSON.stringify(item.images) : null,
          item.attachments?.length ? JSON.stringify(item.attachments) : null,
          item.mode,
          behavior,
          position,
          existing.get(item.id) ?? now,
          now
        )
      }
      if (input.pivot) write(input.pivot, 'pivot', 0)
      input.queued.forEach((item, index) => write(item, 'queue', index))
    })()
    return this.list(input.conversationId)
  }

  takeNext(conversationId: string): PromptAdmissionItem | null {
    return this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT * FROM agent_prompt_admissions
           WHERE conversation_id = ?
           ORDER BY CASE behavior WHEN 'pivot' THEN 0 ELSE 1 END, position, created_at, id
           LIMIT 1`
        )
        .get(conversationId) as AdmissionRow | undefined
      if (!row) return null
      this.db.prepare('DELETE FROM agent_prompt_admissions WHERE id = ?').run(row.id)
      return toItem(row)
    })()
  }
}
