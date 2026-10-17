import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronRight } from 'lucide-react'
import type { AppMenuItem, AppMenuRequest } from '../../../shared/appMenus'
import './AppMenuHost.css'

const MARGIN = 8
const SUBMENU_DELAY_MS = 120

function choosable(item: AppMenuItem): boolean {
  return item.type !== 'separator' && item.type !== 'heading' && item.enabled !== false
}

function step(items: AppMenuItem[], from: number, direction: 1 | -1): number {
  for (let offset = 1; offset <= items.length; offset += 1) {
    const index = (from + direction * offset + items.length * 2) % items.length
    if (choosable(items[index])) return index
  }
  return from
}

/**
 * Places a menu at its point, or beside the row that opened it, inside the window: it flips left
 * of or above that point when it would overflow. It writes the position straight to the element,
 * before paint, since it depends on the menu's own measured size.
 */
function useMenuPlacement(
  ref: React.RefObject<HTMLDivElement | null>,
  point: { x: number; y: number } | undefined,
  anchor: (() => HTMLElement | null) | undefined
): void {
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const row = anchor?.()?.getBoundingClientRect()
    const x = row ? row.right - 4 : (point?.x ?? 0)
    const y = row ? row.top - 5 : (point?.y ?? 0)
    const flipX = row ? row.left + 4 : x
    const flipY = row ? row.bottom + 5 : y
    const { width, height } = element.getBoundingClientRect()
    const fitsRight = x + width + MARGIN <= window.innerWidth
    const fitsBelow = y + height + MARGIN <= window.innerHeight
    const left = fitsRight ? x : Math.min(flipX - width, window.innerWidth - width - MARGIN)
    const top = fitsBelow ? y : Math.min(flipY - height, window.innerHeight - height - MARGIN)
    element.style.left = `${Math.max(MARGIN, left)}px`
    element.style.top = `${Math.max(MARGIN, top)}px`
    element.style.visibility = 'visible'
  })
}

interface MenuListProps {
  items: AppMenuItem[]
  /** Where the top menu opens. */
  point?: { x: number; y: number }
  /** The row a submenu opens beside. */
  anchor?: () => HTMLElement | null
  /** The highlighted item at each open level. */
  path: number[]
  /** How many levels are open below the top menu. */
  openDepth: number
  depth: number
  onHover: (depth: number, index: number) => void
  onChoose: (item: AppMenuItem, depth: number, index: number) => void
}

function MenuList({
  items,
  point,
  anchor,
  path,
  openDepth,
  depth,
  onHover,
  onChoose
}: MenuListProps): React.JSX.Element {
  const active = path[depth] ?? -1
  const openSubmenu =
    openDepth > depth && active >= 0 && items[active]?.type === 'submenu' ? active : null
  const ref = useRef<HTMLDivElement>(null)
  useMenuPlacement(ref, point, anchor)
  const rowRefs = useRef<Array<HTMLDivElement | null>>([])
  const submenuItem = openSubmenu !== null ? items[openSubmenu] : undefined

  return (
    <>
      <div
        ref={ref}
        className={`app-menu${depth ? ' is-submenu' : ''}`}
        role="menu"
        style={{ left: 0, top: 0, visibility: 'hidden' }}
        // The field that was right-clicked keeps focus, so Cut and Paste still reach it.
        onMouseDown={(event) => event.preventDefault()}
        onContextMenu={(event) => event.preventDefault()}
      >
        {items.map((item, index) => {
          if (item.type === 'separator')
            return <div key={item.id} className="app-menu-separator" role="separator" />
          if (item.type === 'heading')
            return (
              <div key={item.id} className="app-menu-heading" role="presentation">
                {item.label}
              </div>
            )
          const disabled = item.enabled === false
          return (
            <div
              key={item.id}
              ref={(element) => {
                rowRefs.current[index] = element
              }}
              role={item.type === 'checkbox' ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked={item.type === 'checkbox' ? Boolean(item.checked) : undefined}
              aria-disabled={disabled || undefined}
              aria-haspopup={item.type === 'submenu' ? 'menu' : undefined}
              aria-expanded={item.type === 'submenu' ? openSubmenu === index : undefined}
              className={`app-menu-item${index === active ? ' is-active' : ''}${
                disabled ? ' is-disabled' : ''
              }`}
              onPointerMove={() => !disabled && onHover(depth, index)}
              onClick={() => !disabled && onChoose(item, depth, index)}
            >
              <span className="app-menu-mark" aria-hidden="true">
                {item.icon ? (
                  <img src={item.icon} alt="" width={16} height={16} />
                ) : item.type === 'checkbox' && item.checked ? (
                  <Check size={14} />
                ) : null}
              </span>
              <span className="app-menu-label">{item.label}</span>
              {item.shortcut && <span className="app-menu-shortcut">{item.shortcut}</span>}
              {item.type === 'submenu' && (
                <ChevronRight size={13} className="app-menu-chevron" aria-hidden="true" />
              )}
            </div>
          )
        })}
      </div>
      {submenuItem?.submenu && openSubmenu !== null && (
        <MenuList
          items={submenuItem.submenu}
          anchor={() => rowRefs.current[openSubmenu] ?? null}
          path={path}
          openDepth={openDepth}
          depth={depth + 1}
          onHover={onHover}
          onChoose={onChoose}
        />
      )}
    </>
  )
}

/**
 * Draws the menus the main process opens, such as a file's actions or a text field's edit menu,
 * in SideKick's style instead of the system's. Choosing an item asks the main process to perform
 * it; the menu never runs anything itself.
 */
export function AppMenuHost(): React.JSX.Element | null {
  const [menu, setMenu] = useState<AppMenuRequest | null>(null)
  // The highlighted item at each open level, from the top menu down.
  const [path, setPath] = useState<number[]>([])
  const [openDepth, setOpenDepth] = useState(0)
  const hoverTimer = useRef<number | undefined>(undefined)

  useEffect(
    () =>
      window.api.menus.onShow((request) => {
        setMenu(request)
        setPath([-1])
        setOpenDepth(0)
      }),
    []
  )

  const close = useCallback((chosen = false): void => {
    setMenu((current) => {
      if (current && !chosen) void window.api.menus.dismiss(current.token)
      return null
    })
    window.clearTimeout(hoverTimer.current)
  }, [])

  const levels = (): AppMenuItem[][] => {
    if (!menu) return []
    const result = [menu.items]
    for (let depth = 0; depth < openDepth; depth += 1) {
      const parent = result[depth][path[depth]]
      if (!parent?.submenu) break
      result.push(parent.submenu)
    }
    return result
  }

  const choose = (item: AppMenuItem, depth: number, index: number): void => {
    if (!menu || !choosable(item)) return
    if (item.type === 'submenu') {
      setPath((current) => [...current.slice(0, depth), index, -1])
      setOpenDepth(depth + 1)
      return
    }
    void window.api.menus.choose(menu.token, item.id)
    close(true)
  }

  const hover = (depth: number, index: number): void => {
    setPath((current) => [...current.slice(0, depth), index])
    window.clearTimeout(hoverTimer.current)
    const item = levels()[depth]?.[index]
    // Moving onto a submenu's row opens it after a moment; onto another row closes deeper ones.
    hoverTimer.current = window.setTimeout(() => {
      if (item?.type === 'submenu') {
        setPath((current) => [...current.slice(0, depth + 1), -1])
        setOpenDepth(depth + 1)
      } else setOpenDepth(depth)
    }, SUBMENU_DELAY_MS)
  }

  // Keys move through the menu while focus stays where it was.
  useEffect(() => {
    if (!menu) return
    const onKey = (event: KeyboardEvent): void => {
      const all = levels()
      const depth = Math.min(openDepth, all.length - 1)
      const items = all[depth]
      const index = path[depth] ?? -1
      const consume = (): void => {
        event.preventDefault()
        event.stopPropagation()
      }
      switch (event.key) {
        case 'ArrowDown':
          consume()
          setPath((current) => [...current.slice(0, depth), step(items, index, 1)])
          return
        case 'ArrowUp':
          consume()
          setPath((current) => [...current.slice(0, depth), step(items, index < 0 ? 0 : index, -1)])
          return
        case 'ArrowRight':
          consume()
          if (items[index]?.type === 'submenu') choose(items[index], depth, index)
          return
        case 'ArrowLeft':
          consume()
          if (depth > 0) setOpenDepth(depth - 1)
          return
        case 'Enter':
        case ' ':
          consume()
          if (index >= 0) choose(items[index], depth, index)
          return
        case 'Escape':
          consume()
          if (depth > 0) setOpenDepth(depth - 1)
          else close()
          return
        case 'Tab':
          consume()
          close()
      }
    }
    const outside = (event: PointerEvent): void => {
      if ((event.target as Element | null)?.closest?.('.app-menu')) return
      close()
    }
    const dismiss = (): void => close()
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('blur', dismiss)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('resize', dismiss)
    }
  })

  if (!menu) return null
  return (
    <MenuList
      key={menu.token}
      items={menu.items}
      point={{ x: menu.x, y: menu.y }}
      path={path}
      openDepth={openDepth}
      depth={0}
      onHover={hover}
      onChoose={choose}
    />
  )
}
