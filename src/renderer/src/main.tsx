import { createRoot } from 'react-dom/client'
import App from './App'
import { installBrowserApiMock } from './dev/browserApiMock'

if (new URLSearchParams(window.location.search).has('ui-preview')) {
  installBrowserApiMock()
}

// Strict Mode disabled to prevent double-render of Chart.js artifacts
// Strict Mode runs useEffects twice in dev, causing "Canvas already in use" errors
createRoot(document.getElementById('root')!).render(<App />)
