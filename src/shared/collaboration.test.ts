import { describe, expect, it } from 'vitest'
import { normalizeCollaborationHumanAddress } from './collaboration'

describe('collaboration human addressing', () => {
  it('normalizes model-invented human mentions without changing agent mentions', () => {
    expect(normalizeCollaborationHumanAddress('@User — please review this.')).toEqual({
      text: 'You — please review this.',
      mentionedHuman: true
    })
    expect(normalizeCollaborationHumanAddress('Ask @Webpage agent, then notify @Human.')).toEqual({
      text: 'Ask @Webpage agent, then notify you.',
      mentionedHuman: true
    })
  })

  it('leaves ordinary public messages unchanged', () => {
    expect(normalizeCollaborationHumanAddress('The dataset is ready for everyone.')).toEqual({
      text: 'The dataset is ready for everyone.',
      mentionedHuman: false
    })
  })
})
