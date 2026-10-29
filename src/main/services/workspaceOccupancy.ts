import { realpathSync } from 'fs'
import { relative, resolve, isAbsolute, sep } from 'path'
import { workspaceBusyMessage, type WorkspaceOccupant } from '../../shared/worktrees'

interface Claim extends WorkspaceOccupant {
  /** The canonical folder used for comparison. */
  key: string
}

function canonical(folder: string): string {
  let path = resolve(folder)
  try {
    path = realpathSync.native(path)
  } catch {
    // A folder that is gone still compares by its resolved path.
  }
  return process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path
}

/** One folder contains the other, or they are the same folder. */
function overlaps(left: string, right: string): boolean {
  const inside = (child: string, parent: string): boolean => {
    const path = relative(parent, child)
    return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
  }
  return inside(left, right) || inside(right, left)
}

/**
 * The folders that running agents are writing in. Two agents writing in one folder overwrite each
 * other's work, so a run that would join a busy folder is refused unless its caller chose to share.
 * Held in memory: after a restart no run is active, so there is nothing to restore.
 */
export class WorkspaceOccupancy {
  private readonly claims = new Map<string, Claim>()

  /** Writing runs in the same folder, or one containing or inside it, other than this conversation's. */
  occupants(workspaceRoot: string, conversationId: string): WorkspaceOccupant[] {
    const key = canonical(workspaceRoot)
    const runs = new Map<string, WorkspaceOccupant>()
    for (const { key: claimed, ...occupant } of this.claims.values()) {
      if (occupant.conversationId === conversationId || !overlaps(claimed, key)) continue
      if (!runs.has(occupant.runId)) runs.set(occupant.runId, occupant)
    }
    return [...runs.values()]
  }

  /**
   * Checks and claims in one step, so two runs starting together cannot both see a free folder.
   * Throws the busy message unless the caller chose to share the folder.
   */
  admit(occupant: WorkspaceOccupant, sharing?: 'allow'): () => void {
    const occupants = this.occupants(occupant.workspaceRoot, occupant.conversationId)
    if (occupants.length && sharing !== 'allow') throw new Error(workspaceBusyMessage(occupants))
    return this.claim(occupant)
  }

  /**
   * Records a writing run in a folder; a run may claim each folder of its project. The returned
   * function releases the claim and is safe to call twice.
   */
  claim(occupant: WorkspaceOccupant): () => void {
    const key = canonical(occupant.workspaceRoot)
    const id = `${occupant.runId}\0${key}`
    this.claims.set(id, { ...occupant, key })
    return () => {
      this.claims.delete(id)
    }
  }
}
