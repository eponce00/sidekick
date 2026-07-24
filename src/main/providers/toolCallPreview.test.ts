import { describe, expect, it } from 'vitest'
import { previewToolCallArguments } from './toolCallPreview'

describe('tool call preview', () => {
  it('extracts presentation fields before a large file payload finishes', () => {
    expect(
      previewToolCallArguments(
        '{"file_path":"src/app.tsx","content":"export default function App() {'
      )
    ).toEqual({ file_path: 'src/app.tsx' })
  })

  it('decodes escaped paths without retaining command or file contents', () => {
    expect(
      previewToolCallArguments(
        '{"title":"Build app","type":"html","command":"npm run build","path":"src\\\\app.ts","content":"secret"}'
      )
    ).toEqual({ path: 'src\\app.ts', title: 'Build app', type: 'html' })
  })
})
