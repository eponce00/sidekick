import type Database from 'better-sqlite3'

/** Seals device secrets with the operating system's key store when it has one. */
export interface DeviceSecretCipher {
  isAvailable(): boolean
  encrypt(value: string): Uint8Array
  decrypt(value: Uint8Array): string
}

export interface StoredCompanionDevice {
  id: string
  name: string
  createdAt: number
  lastSeenAt: number | null
  lastAddress: string | null
}

interface DeviceRow {
  id: string
  name: string
  secret: Buffer
  secret_sealed: number
  created_at: number
  last_seen_at: number | null
  last_address: string | null
}

/** The phones the user approved, each with the secret its connections are keyed with. */
export class CompanionDeviceStore {
  constructor(
    private readonly db: Database.Database,
    private readonly cipher: DeviceSecretCipher,
    private readonly now: () => number = Date.now
  ) {}

  list(): StoredCompanionDevice[] {
    const rows = this.db
      .prepare('SELECT * FROM companion_devices ORDER BY created_at DESC')
      .all() as DeviceRow[]
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      lastAddress: row.last_address
    }))
  }

  add(device: { id: string; name: string; secret: string; address: string }): void {
    const sealed = this.cipher.isAvailable()
    this.db
      .prepare(
        `INSERT INTO companion_devices (id, name, secret, secret_sealed, created_at, last_address)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        device.id,
        device.name,
        sealed
          ? Buffer.from(this.cipher.encrypt(device.secret))
          : Buffer.from(device.secret, 'utf8'),
        sealed ? 1 : 0,
        this.now(),
        device.address
      )
  }

  /** The device's secret, or null for a device that is not paired. */
  secret(id: string): string | null {
    const row = this.db
      .prepare('SELECT secret, secret_sealed FROM companion_devices WHERE id = ?')
      .get(id) as Pick<DeviceRow, 'secret' | 'secret_sealed'> | undefined
    if (!row) return null
    try {
      return row.secret_sealed
        ? this.cipher.decrypt(new Uint8Array(row.secret))
        : row.secret.toString('utf8')
    } catch {
      // A secret the key store can no longer open cannot be used; the phone pairs again.
      return null
    }
  }

  touch(id: string, address: string): void {
    this.db
      .prepare('UPDATE companion_devices SET last_seen_at = ?, last_address = ? WHERE id = ?')
      .run(this.now(), address, id)
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM companion_devices WHERE id = ?').run(id).changes > 0
  }
}
