import { createRoot } from 'react-dom/client'
// The desktop's design tokens, so the phone matches it in both themes.
import '../styles/App.css'
import './companion.css'
import CompanionApp, { type CompanionBoot } from './CompanionApp'
import { storedDevice, takePairingSecret } from './companionClient'

// The tokens are dark unless the body says light; the phone follows its own system setting.
const light = window.matchMedia('(prefers-color-scheme: light)')
const applyTheme = (): void => {
  if (light.matches) document.body.dataset.theme = 'light'
  else delete document.body.dataset.theme
}
applyTheme()
light.addEventListener('change', applyTheme)

async function boot(): Promise<CompanionBoot> {
  if (new URLSearchParams(window.location.search).has('preview')) {
    // Loaded only for the preview, so a paired phone never downloads the canned data.
    const { CompanionPreview, PREVIEW_DEVICE } = await import('./companionPreview')
    return {
      secret: null,
      device: null,
      preview: { device: PREVIEW_DEVICE, connection: new CompanionPreview() }
    }
  }
  // Read once: taking the secret also removes it from the address bar.
  return { secret: takePairingSecret(), device: storedDevice() }
}

void boot().then((value) => {
  createRoot(document.getElementById('root')!).render(<CompanionApp boot={value} />)
})

// A new code opened in a tab already showing this page changes only the address's fragment, which
// does not load the page again; start over so the new code is read.
window.addEventListener('hashchange', () => {
  if (/(?:^#|&)p=/.test(window.location.hash)) window.location.reload()
})
