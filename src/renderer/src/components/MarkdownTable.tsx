import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'

/** A column never starts narrower than its content on one line, up to this many ems. */
const NATURAL_MIN_EM = 16
/** A column whose every cell is at most this many characters ('#', 'B1') is compact. */
const COMPACT_MAX_CHARS = 4
/** The narrowest a column can be dragged to. */
const RESIZE_MIN_PX = 48
/** How far an arrow key moves a focused column edge. */
const KEY_STEP_PX = 16

interface TableResize {
  begin(cell: HTMLTableCellElement, clientX: number): void
  step(cell: HTMLTableCellElement, by: number): void
  reset(): void
}

const TableResizeContext = createContext<TableResize | null>(null)

/**
 * A reply's table. Each column starts as wide as its content on one line, up to a limit, so short
 * columns such as names and numbers never wrap and the table scrolls sideways in its card rather
 * than squeezing. Dragging a header's edge resizes that column, as in a spreadsheet; double-clicking
 * an edge fits the columns to their content again.
 */
export function MarkdownTable({ children }: { children?: ReactNode }): React.JSX.Element {
  const tableRef = useRef<HTMLTableElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Widths the user dragged the columns to; until then they follow their content.
  const [sized, setSized] = useState<number[] | null>(null)

  // Marks which ends of a table wider than its card are reached, so the card fades only the edge
  // that has more to show. Set on the element rather than in state: it changes on every scroll.
  // Only while it overflows is the scroller a named, focusable region, so the keyboard can scroll
  // it; a table that fits adds no tab stop.
  const markScrollEdges = useCallback((): void => {
    const scroller = scrollRef.current
    if (!scroller) return
    const hidden = scroller.scrollWidth - scroller.clientWidth
    scroller.classList.toggle('is-scroll-start', scroller.scrollLeft <= 1)
    scroller.classList.toggle('is-scroll-end', scroller.scrollLeft >= hidden - 1)
    if (hidden > 1) {
      scroller.tabIndex = 0
      scroller.setAttribute('role', 'region')
      scroller.setAttribute('aria-label', 'Table, scrolls sideways')
    } else {
      scroller.removeAttribute('tabindex')
      scroller.removeAttribute('role')
      scroller.removeAttribute('aria-label')
    }
  }, [])

  // Each header cell's minimum is its column's content on one line, up to the limit, measured
  // after every render, since a streaming reply grows its table cell by cell. In an automatic
  // table layout a header cell's minimum width is its column's.
  useLayoutEffect(() => {
    const table = tableRef.current
    const header = table?.tHead?.rows[0] ?? table?.rows[0]
    if (!table || !header) return
    const cells = [...header.cells]
    for (const cell of cells) cell.style.minWidth = ''
    if (!sized) {
      table.classList.add('is-measuring')
      const limit = NATURAL_MIN_EM * (parseFloat(getComputedStyle(table).fontSize) || 13)
      const widths = cells.map((cell) =>
        Math.ceil(Math.min(cell.getBoundingClientRect().width, limit))
      )
      table.classList.remove('is-measuring')
      cells.forEach((cell, index) => (cell.style.minWidth = `${widths[index]}px`))
    }
    markColumnShapes(table)
    markScrollEdges()
  })

  // The card's width follows its panel, so the edges change on resize as well as on scroll.
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (!scroller || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(markScrollEdges)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [markScrollEdges])

  const columnWidths = useCallback((): number[] => {
    const header = tableRef.current?.tHead?.rows[0] ?? tableRef.current?.rows[0]
    return header ? [...header.cells].map((cell) => cell.getBoundingClientRect().width) : []
  }, [])

  const resize = useMemo<TableResize>(
    () => ({
      begin(cell, startX) {
        const index = cell.cellIndex
        const start = sized ?? columnWidths()
        const from = start[index] ?? cell.getBoundingClientRect().width
        const move = (event: PointerEvent): void => {
          const width = Math.max(RESIZE_MIN_PX, Math.round(from + event.clientX - startX))
          setSized((current) => {
            const next = [...(current ?? start)]
            next[index] = width
            return next
          })
        }
        const stop = (): void => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', stop)
          window.removeEventListener('pointercancel', stop)
          document.body.classList.remove('is-resizing-table')
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', stop)
        window.addEventListener('pointercancel', stop)
        document.body.classList.add('is-resizing-table')
      },
      step(cell, by) {
        const index = cell.cellIndex
        setSized((current) => {
          const next = [...(current ?? columnWidths())]
          next[index] = Math.max(RESIZE_MIN_PX, Math.round((next[index] ?? 0) + by))
          return next
        })
      },
      reset() {
        setSized(null)
      }
    }),
    [columnWidths, sized]
  )

  return (
    <TableResizeContext.Provider value={resize}>
      {/* The card draws the border; the scroller inside it fades its edges, which would also
          fade a border drawn on itself. */}
      <div className="markdown-table">
        <div
          ref={scrollRef}
          className="markdown-table-scroll is-scroll-start is-scroll-end"
          onScroll={markScrollEdges}
        >
          <table
            ref={tableRef}
            className={sized ? 'is-sized' : undefined}
            style={sized ? { width: sized.reduce((total, width) => total + width, 0) } : undefined}
          >
            {sized && (
              <colgroup>
                {sized.map((width, index) => (
                  <col key={index} style={{ width }} />
                ))}
              </colgroup>
            )}
            {children}
          </table>
        </div>
      </div>
    </TableResizeContext.Provider>
  )
}

/**
 * Marks cells by their column's shape, so a narrow document column can give its width to the
 * prose: `is-compact` on every cell of a column of short labels, and `is-code` on a cell whose
 * only content is inline code or a file chip. Only the file viewer styles them.
 */
function markColumnShapes(table: HTMLTableElement): void {
  const rows = [...table.rows]
  const columns = Math.max(0, ...rows.map((row) => row.cells.length))
  for (let index = 0; index < columns; index += 1) {
    const cells = rows.flatMap((row) => (row.cells[index] ? [row.cells[index]] : []))
    const compact = cells.every(
      (cell) => (cell.textContent ?? '').trim().length <= COMPACT_MAX_CHARS
    )
    for (const cell of cells) cell.classList.toggle('is-compact', compact)
  }
  for (const row of rows) {
    for (const cell of row.cells) {
      const only = cell.children.length === 1 ? cell.children[0] : null
      const code =
        !!only &&
        only.matches('code, .markdown-file-reference') &&
        (cell.textContent ?? '').trim() === (only.textContent ?? '').trim()
      cell.classList.toggle('is-code', code)
    }
  }
}

/** A header cell with the edge that resizes its column. */
export function MarkdownTableHeader({
  children,
  ...props
}: ComponentPropsWithoutRef<'th'>): React.JSX.Element {
  const resize = useContext(TableResizeContext)
  const cell = (event: { currentTarget: HTMLElement }): HTMLTableCellElement | null =>
    event.currentTarget.closest('th')
  return (
    <th {...props}>
      {children}
      {resize && (
        <span
          className="markdown-table-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize column"
          tabIndex={0}
          onPointerDown={(event: ReactPointerEvent<HTMLSpanElement>) => {
            if (event.button !== 0) return
            const target = cell(event)
            if (!target) return
            event.preventDefault()
            resize.begin(target, event.clientX)
          }}
          onDoubleClick={() => resize.reset()}
          onKeyDown={(event: ReactKeyboardEvent<HTMLSpanElement>) => {
            const target = cell(event)
            if (!target) return
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault()
              resize.step(target, event.key === 'ArrowLeft' ? -KEY_STEP_PX : KEY_STEP_PX)
            } else if (event.key === 'Enter') {
              event.preventDefault()
              resize.reset()
            }
          }}
        />
      )}
    </th>
  )
}
