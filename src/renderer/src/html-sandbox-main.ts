import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import './styles/artifactTokens.css'
import './styles/artifactBase.css'
import './styles/artifactFlow.css'
import type { ArtifactHostCommand } from '../../shared/artifactFrame'
import type { ArtifactTheme } from '../../shared/artifactTheme'
import {
  listenToHost,
  postToHost,
  reportPointerToHost,
  watchContentHeight
} from './utils/artifactFrameChannel'
import { applyArtifactTheme, createArtifactThemeStyle } from './utils/artifactTheme'
import { buildArtifactDocument } from './utils/htmlArtifactDocument'

// Runs one HTML or SVG artifact on the artifact origin. The artifact becomes this page's whole
// document, written in place so its inline scripts run under this page's policy and its
// DOMContentLoaded and load events fire as in any page.

let stopWatching: (() => void) | null = null
let stopListening: (() => void) | null = null
let failed = false
/** This frame shows drafts of the artifact while it is written, and reports nothing but height. */
let drafting = false

function onError(event: ErrorEvent): void {
  if (drafting) return
  failed = true
  postToHost({ type: 'error', error: event.message || 'HTML artifact error' })
}

function onRejection(event: PromiseRejectionEvent): void {
  if (drafting) return
  failed = true
  const reason = event.reason instanceof Error ? event.reason.message : String(event.reason)
  postToHost({ type: 'error', error: reason })
}

function listen(): void {
  stopListening?.()
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  const stopHost = listenToHost(handle)
  const stopPointer = reportPointerToHost()
  stopListening = () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
    stopHost()
    stopPointer()
  }
}

function applyTheme(theme: ArtifactTheme): void {
  applyArtifactTheme(document, theme)
  document.dispatchEvent(new Event('sidekick-artifact-themechange'))
}

function render(code: string, theme: ArtifactTheme): void {
  stopWatching?.()
  failed = false
  // This page's stylesheets (fonts, tokens, SideKick's base layer) go first in the artifact's
  // head, and the theme with them, so the artifact's scripts see it as soon as they run.
  const ownStyles = [...document.querySelectorAll('link[rel="stylesheet"], style')]
    .map((element) => element.outerHTML)
    .join('\n')
  const head = `${ownStyles}\n<style id="sidekick-artifact-theme">${createArtifactThemeStyle(theme)}</style>`
  document.open()
  // Opening the document removed every listener. The artifact's scripts run while it is written,
  // so errors are listened for again before the first of them.
  listen()
  document.write(buildArtifactDocument(code, head))
  document.close()
  applyTheme(theme)
  stopWatching = watchContentHeight(document, (height) =>
    postToHost({ type: 'resize', height })
  ).stop
  const finish = (): void => {
    if (!failed) postToHost({ type: 'success' })
  }
  if (document.readyState === 'complete') finish()
  else window.addEventListener('load', finish, { once: true })
}

/**
 * The markup that has arrived, shown without running its scripts or inline event handlers: the
 * parser closes what is still open, and the styles it has so far apply.
 */
function renderDraft(code: string, theme: ArtifactTheme): void {
  if (!drafting) {
    drafting = true
    document.body.replaceChildren()
    stopWatching = watchContentHeight(document, (height) =>
      postToHost({ type: 'resize', height })
    ).stop
  }
  applyTheme(theme)
  const parsed = new DOMParser().parseFromString(buildArtifactDocument(code, ''), 'text/html')
  for (const script of parsed.querySelectorAll('script')) script.remove()
  for (const element of parsed.querySelectorAll('*')) {
    for (const { name } of [...element.attributes]) {
      if (/^on/i.test(name)) element.removeAttribute(name)
    }
  }
  const styles = [...parsed.querySelectorAll('style')].map((style) => style.textContent).join('\n')
  let draftStyle = document.getElementById('sidekick-artifact-draft-style')
  if (!draftStyle) {
    draftStyle = document.createElement('style')
    draftStyle.id = 'sidekick-artifact-draft-style'
    document.head.appendChild(draftStyle)
  }
  draftStyle.textContent = styles
  for (const style of parsed.body.querySelectorAll('style')) style.remove()
  document.body.innerHTML = parsed.body.innerHTML
}

function handle(command: ArtifactHostCommand): void {
  if (command.type === 'draft') renderDraft(command.code, command.theme)
  else if (command.type === 'render') {
    if (!drafting) render(command.code, command.theme)
  } else applyTheme(command.theme)
}

listen()
postToHost({ type: 'ready' })
