import { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const plugins = [remarkGfm]

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  // The page loads nothing from the network, so a picture in a reply shows as its name.
  img: ({ alt }) => <span className="cp-md-image">{alt ? `[Image: ${alt}]` : '[Image]'}</span>,
  // Wide tables scroll on their own instead of widening the page.
  table: ({ children }) => (
    <div className="cp-md-table">
      <table>{children}</table>
    </div>
  )
}

/** An assistant reply's text; raw HTML in it is dropped, not rendered. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="cp-md">
      <ReactMarkdown remarkPlugins={plugins} components={components} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  )
})
