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
  // Widths the user dragged the columns to; until then they follow their content.
  const [sized, setSized] = useState<number[] | null>(null)

  // Each header cell's minimum is its column's content on one line, up to the limit, measured
  // after every render, since a streaming reply grows its table cell by cell. In an automatic
  // table layout a header cell's minimum width is its column's.
  useLayoutEffect(() => {
    const table = tableRef.current
    const header = table?.tHead?.rows[0] ?? table?.rows[0]
    if (!table || !header) return
    const cells = [...header.cells]
    for (const cell of cells) cell.style.minWidth = ''
    if (sized) return
    table.classList.add('is-measuring')
    const limit = NATURAL_MIN_EM * (parseFloat(getComputedStyle(table).fontSize) || 13)
    const widths = cells.map((cell) =>
      Math.ceil(Math.min(cell.getBoundingClientRect().width, limit))
    )
    table.classList.remove('is-measuring')
    cells.forEach((cell, index) => (cell.style.minWidth = `${widths[index]}px`))
  })

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
      <div className="markdown-table">
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
    </TableResizeContext.Provider>
  )
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
