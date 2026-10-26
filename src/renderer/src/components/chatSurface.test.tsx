// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentInteractionCard from './AgentInteractionCard'
import Artifact from './artifacts/Artifact'
import { ChatSurfaceContext, type ChatSurface } from './chatSurface'
import { MessageMapCard } from './MessageMapCard'
import { SurfaceImage } from './SurfaceImage'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./MessageMapPreview', () => ({ default: () => <div data-testid="map-preview" /> }))

const PHONE: ChatSurface = {
  resolveImage: async (src) =>
    src.startsWith('data:') ? src : src.endsWith('/kept') ? 'data:image/png;base64,AA==' : null,
  computerOnly: 'Open this on the computer to use it.',
  offline: true
}

describe('the chat surface', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  async function render(node: ReactNode, surface?: ChatSurface): Promise<void> {
    await act(async () => {
      root.render(
        surface ? (
          <ChatSurfaceContext.Provider value={surface}>{node}</ChatSurfaceContext.Provider>
        ) : (
          node
        )
      )
    })
  }

  it('leaves images, artifacts and maps as they are on the desktop', async () => {
    await render(<SurfaceImage src="https://example.com/a.png" alt="A" fallback="none" />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/a.png')
    await render(
      <Artifact
        artifact={{ type: 'svg', title: 'Chart', code: '<svg></svg>', isStreaming: false }}
      />
    )
    expect(container.textContent).not.toContain('Open this on the computer')
  })

  it('loads an image through the surface, or shows its fallback', async () => {
    await render(
      <>
        <SurfaceImage src="sidekick-browser://artifact/kept" alt="Kept" />
        <SurfaceImage src="https://cdn.example.com/emoji.svg" alt="🎉" fallback="🎉" />
      </>,
      PHONE
    )
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AA==')
    expect(container.querySelectorAll('img')).toHaveLength(1)
    expect(container.textContent).toBe('🎉')
  })

  it('names an artifact instead of running it where it cannot run', async () => {
    await render(
      <Artifact
        artifact={{ type: 'html', title: 'Mockup', code: '<p>Hi</p>', isStreaming: false }}
      />,
      PHONE
    )
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.textContent).toContain('Mockup')
    expect(container.textContent).toContain('Open this on the computer to use it.')
  })

  it('leaves out the interactive map where nothing may load from the network', async () => {
    const location = {
      href: 'https://www.google.com/maps/search/?api=1&query=Lisbon',
      provider: 'google' as const,
      providerLabel: 'Google Maps',
      label: 'Lisbon',
      query: 'Lisbon',
      zoom: 12,
      embedUrl: 'https://www.google.com/maps?q=Lisbon&output=embed'
    }
    await render(<MessageMapCard location={location} />, PHONE)
    expect(container.textContent).toContain('Lisbon')
    expect(container.querySelector('[data-testid="map-preview"]')).toBeNull()
    expect(container.querySelector('[aria-label="Open map full screen"]')).toBeNull()
  })

  it('sends starting chats to the computer', async () => {
    const onResolve = vi.fn()
    await render(
      <AgentInteractionCard
        interaction={{
          id: 'i',
          kind: 'question',
          status: 'pending',
          request: { intent: 'start_sessions', sessions: [] }
        }}
        onResolve={onResolve}
      />,
      PHONE
    )
    expect(container.textContent).toContain('SideKick wants to start other chats')
    expect(container.textContent).toContain('Open this on the computer to use it.')
    expect(container.querySelector('button')).toBeNull()
  })
})
