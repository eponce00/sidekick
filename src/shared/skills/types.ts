// Skills system types

/**
 * How the skill can be invoked:
 * - 'always'  Full instructions always injected into the system prompt (use for high-frequency skills).
 * - 'auto'    LLM sees the description and calls `use_skill` to load full content on demand.
 * - 'manual'  Reserved for skills that are hidden from automatic model discovery.
 */
export type SkillInvocation = 'always' | 'auto' | 'manual'

/**
 * How long a loaded skill remains active:
 * - 'conversation'  Persist it and inject it again on later turns in the same conversation.
 * - 'run'           Keep it only for the current agent run; the tool result carries its instructions.
 */
export type SkillActivationScope = 'conversation' | 'run'

/**
 * A Skill is a bundle of instructions that the agent loads to improve
 * performance on specialised tasks. Follows the Agent Skills open standard
 * (agentskills.io), adapted for this Electron desktop app.
 */
export interface Skill {
  id: string
  name: string
  /** Icon key mapped to a Lucide icon in the UI layer */
  icon: string
  /** Short one-line description — always shown to LLM for 'auto' skills so it can decide when to invoke */
  description: string
  /**
   * Invocation mode (default: 'auto').
   * - 'always': injected every turn (for very frequently-used skills)
   * - 'auto': LLM calls `use_skill` when needed; description always visible to LLM
   * - 'manual': hidden from LLM auto-invocation
   */
  invocation: SkillInvocation
  /** Whether activation survives beyond the current agent run (default: 'conversation'). */
  activationScope: SkillActivationScope
  /** Full markdown instructions injected into the system prompt when this skill is active */
  systemPromptInjection: string
  /** Whether this skill requires Python to be available on the system */
  requiresPython?: boolean
  /** npm packages this skill needs (just for documentation / preflight hint) */
  requiresNodePackages?: string[]
  /** pip packages this skill needs (just for documentation / preflight hint) */
  requiresPythonPackages?: string[]
}
