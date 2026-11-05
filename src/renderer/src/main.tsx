import { createRoot } from 'react-dom/client'
import App from './App'
import { PanelWindow } from './PanelWindow'
import { installBrowserApiMock } from './dev/browserApiMock'
import { panelWindowFromQuery } from '../../shared/panelWindows'

if (new URLSearchParams(window.location.search).has('ui-preview')) {
  installBrowserApiMock()
}

// Strict Mode disabled to prevent double-render of Chart.js artifacts
// Strict Mode runs useEffects twice in dev, causing "Canvas already in use" errors
// A window of one side panel app, dragged out of the main window, or the app itself.
const panelWindow = panelWindowFromQuery(window.location.search)
createRoot(document.getElementById('root')!).render(
  panelWindow ? <PanelWindow entry={panelWindow} /> : <App />
)
