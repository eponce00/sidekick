import type { BrowserWindow, Input, MouseInputEvent, WebContentsView } from 'electron'
import type { BrowserPanelBounds } from '../../shared/browserWorkspace'
import type { BrowserAnnotationBox } from '../../shared/messageContextAttachments'

/**
 * The surface marks are made on. A live page is a native view the app cannot draw on, so while
 * the user annotates, a transparent view of SideKick's own covers it, as the agent's cursor does.
 * The page cannot see this view, draw above it, or read what is drawn on it. Nothing in it
 * talks back: the main process reads its mouse and keys from Chromium's input events and only
 * ever tells it what to draw.
 */
export interface BrowserAnnotationOverlayState {
  /** The app's accent color and the text color it carries, each checked to be a plain color. */
  accent: string
  accentText: string
  hover?: BrowserAnnotationBox & { label: string }
  drag?: BrowserAnnotationBox
  marks: Array<BrowserAnnotationBox & { number: number; area: boolean }>
}

export type BrowserAnnotationOverlayInput =
  | { type: 'down' | 'move' | 'up'; x: number; y: number; buttons: boolean }
  | { type: 'leave' }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'escape' }

export interface BrowserAnnotationOverlayHandle {
  place(bounds: BrowserPanelBounds): void
  hide(): void
  readonly visible: boolean
  render(state: BrowserAnnotationOverlayState): void
}

// Drawn over the page rather than the app: the app's accent, with a white rim that stands out
// on any page.
export const OVERLAY_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
:root{--accent:#3b82f6;--on-accent:#fff}
html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden;cursor:crosshair;
user-select:none;font:600 11px/1.25 system-ui,-apple-system,"Segoe UI",sans-serif}
.box{position:absolute;box-sizing:border-box;pointer-events:none;border-radius:3px}
.hover{border:2px solid var(--accent);background:color-mix(in srgb,var(--accent) 14%,transparent)}
.drag{border:2px dashed var(--accent);background:color-mix(in srgb,var(--accent) 10%,transparent)}
.mark{border:2px solid var(--accent);box-shadow:0 0 0 1px rgba(255,255,255,.9)}
.mark.area{border-style:dashed}
.badge{position:absolute;left:-11px;top:-11px;min-width:20px;height:20px;padding:0 5px;
box-sizing:border-box;border-radius:10px;background:var(--accent);color:var(--on-accent);border:2px solid #fff;
display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,.45)}
.label{position:absolute;left:-2px;bottom:100%;margin-bottom:3px;padding:2px 6px;border-radius:4px;
background:var(--accent);color:var(--on-accent);white-space:nowrap;max-width:320px;overflow:hidden;
text-overflow:ellipsis;box-shadow:0 1px 3px rgba(0,0,0,.35)}
.label.below{bottom:auto;top:100%;margin:3px 0 0}
</style></head><body><script>
window.render=(s)=>{
document.documentElement.style.setProperty('--accent',s.accent);
document.documentElement.style.setProperty('--on-accent',s.accentText);
const add=(r,c)=>{const d=document.createElement('div');d.className='box '+c;
d.style.left=r.x+'px';d.style.top=r.y+'px';d.style.width=r.width+'px';d.style.height=r.height+'px';return d};
const nodes=[];
for(const m of s.marks){const d=add(m,m.area?'mark area':'mark');const b=document.createElement('span');
b.className='badge';b.textContent=String(m.number);d.append(b);nodes.push(d)}
if(s.drag)nodes.push(add(s.drag,'drag'));
if(s.hover){const d=add(s.hover,'hover');const l=document.createElement('span');
l.className=s.hover.y<22?'label below':'label';l.textContent=s.hover.label;d.append(l);nodes.push(d)}
document.body.replaceChildren(...nodes)}
</script></body></html>`

export function overlayInput(input: MouseInputEvent): BrowserAnnotationOverlayInput | undefined {
  const buttons = Boolean(input.modifiers?.includes('leftbuttondown'))
  switch (input.type) {
    case 'mouseDown':
      return input.button === 'left' ? { type: 'down', x: input.x, y: input.y, buttons } : undefined
    case 'mouseUp':
      return input.button === 'left' ? { type: 'up', x: input.x, y: input.y, buttons } : undefined
    case 'mouseMove':
      return { type: 'move', x: input.x, y: input.y, buttons }
    case 'mouseLeave':
      return { type: 'leave' }
    case 'mouseWheel': {
      const wheel = input as MouseInputEvent & { deltaX?: number; deltaY?: number }
      return {
        type: 'wheel',
        x: input.x,
        y: input.y,
        deltaX: Number(wheel.deltaX) || 0,
        deltaY: Number(wheel.deltaY) || 0
      }
    }
    default:
      return undefined
  }
}

export async function createBrowserAnnotationOverlay(
  host: BrowserWindow,
  onInput: (input: BrowserAnnotationOverlayInput) => void
): Promise<BrowserAnnotationOverlayHandle> {
  const { WebContentsView: View } = await import('electron')
  const view: WebContentsView = new View({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  view.setBackgroundColor('#00000000')
  view.setVisible(false)
  const contents = view.webContents
  // Its own document only: it never navigates or opens windows.
  contents.on('will-navigate', (event) => event.preventDefault())
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const ready = contents
    .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(OVERLAY_PAGE)}`)
    .then(() => true)
    .catch(() => false)
  let visible = false
  let latest: BrowserAnnotationOverlayState | undefined
  let drawing = false
  let again = false
  const draw = async (): Promise<void> => {
    if (drawing) {
      again = true
      return
    }
    drawing = true
    try {
      do {
        again = false
        if (!(await ready) || contents.isDestroyed() || !latest) return
        await contents
          .executeJavaScript(`window.render(${JSON.stringify(latest)})`)
          .catch(() => undefined)
      } while (again)
    } finally {
      drawing = false
    }
  }
  contents.on('before-mouse-event', (_event, input) => {
    if (!visible) return
    const mapped = overlayInput(input)
    if (mapped) onInput(mapped)
  })
  contents.on('before-input-event', (event, input: Input) => {
    if (!visible || input.type !== 'keyDown') return
    if (input.key === 'Escape') {
      event.preventDefault()
      onInput({ type: 'escape' })
    }
  })
  host.once('closed', () => {
    if (!contents.isDestroyed()) contents.close()
  })
  return {
    get visible() {
      return visible
    },
    place(bounds) {
      if (host.isDestroyed() || contents.isDestroyed()) return
      const children = host.contentView.children
      // Adding a view it already holds raises it above the page, which may have been re-added.
      if (!visible || children[children.length - 1] !== view) host.contentView.addChildView(view)
      view.setBounds(bounds)
      view.setVisible(true)
      if (!visible) contents.focus()
      visible = true
    },
    hide() {
      visible = false
      if (!contents.isDestroyed()) view.setVisible(false)
    },
    render(state) {
      latest = state
      void draw()
    }
  }
}
