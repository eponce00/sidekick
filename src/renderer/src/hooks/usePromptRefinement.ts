import { useCallback, useEffect, useRef, useState } from 'react'
import {
  refinePrompt,
  type PromptRefinementConfig,
  type PromptRefinementResult
} from '../services/providers/promptRefinement'

export type PromptRefinementStatus = 'idle' | 'refining' | 'success' | 'error'

interface UsePromptRefinementOptions {
  value: string
  disabled?: boolean
  config?: PromptRefinementConfig
  onChange: (value: string) => void
  refine?: (draft: string, config: PromptRefinementConfig) => Promise<PromptRefinementResult>
}

export interface PromptRefinementController {
  canRefine: boolean
  status: PromptRefinementStatus
  error: string
  sharpen: () => Promise<void>
  undo: () => void
  handleChange: (value: string) => void
}

type PromptRefinementState =
  | { status: 'idle' }
  | { status: 'refining'; draft: string }
  | { status: 'success'; draft: string; refined: string }
  | { status: 'error'; draft: string; error: string }

const MINIMUM_PROMPT_LENGTH = 8

function visibleState(state: PromptRefinementState, value: string): PromptRefinementState {
  if (state.status === 'success') return state.refined === value ? state : { status: 'idle' }
  if (state.status === 'refining' || state.status === 'error') {
    return state.draft === value ? state : { status: 'idle' }
  }
  return state
}

export function usePromptRefinement({
  value,
  disabled = false,
  config,
  onChange,
  refine = refinePrompt
}: UsePromptRefinementOptions): PromptRefinementController {
  const [state, setState] = useState<PromptRefinementState>({ status: 'idle' })
  const valueRef = useRef(value)
  const requestVersionRef = useRef(0)
  const displayed = visibleState(state, value)

  useEffect(() => {
    valueRef.current = value
  }, [value])

  useEffect(
    () => () => {
      requestVersionRef.current += 1
    },
    []
  )

  const handleChange = useCallback(
    (nextValue: string) => {
      valueRef.current = nextValue
      requestVersionRef.current += 1
      setState({ status: 'idle' })
      onChange(nextValue)
    },
    [onChange]
  )

  const sharpen = useCallback(async () => {
    const currentState = visibleState(state, valueRef.current)
    if (!config || disabled || currentState.status === 'refining') return
    const original = valueRef.current
    if (original.trim().length < MINIMUM_PROMPT_LENGTH) return

    const requestVersion = requestVersionRef.current + 1
    requestVersionRef.current = requestVersion
    setState({ status: 'refining', draft: original })

    const result = await refine(original, config)
    if (requestVersionRef.current !== requestVersion || valueRef.current !== original) return

    if (!result.ok) {
      setState({ status: 'error', draft: original, error: result.error })
      return
    }

    valueRef.current = result.text
    onChange(result.text)
    setState({ status: 'success', draft: original, refined: result.text })
  }, [config, disabled, onChange, refine, state])

  const undo = useCallback(() => {
    if (state.status !== 'success' || state.refined !== valueRef.current) return
    requestVersionRef.current += 1
    valueRef.current = state.draft
    onChange(state.draft)
    setState({ status: 'idle' })
  }, [onChange, state])

  return {
    canRefine:
      Boolean(config) &&
      !disabled &&
      displayed.status !== 'refining' &&
      value.trim().length >= MINIMUM_PROMPT_LENGTH,
    status: displayed.status,
    error: displayed.status === 'error' ? displayed.error : '',
    sharpen,
    undo,
    handleChange
  }
}
