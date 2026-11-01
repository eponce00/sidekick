window.tailwind = window.tailwind || {}
// Tailwind's defaults point at SideKick's tokens, so `font-sans`, a bare `border` and `ring` look
// like the app and follow its theme.
window.tailwind.config = {
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)']
      },
      borderColor: {
        DEFAULT: 'var(--border)'
      },
      ringColor: {
        DEFAULT: 'var(--accent)'
      },
      colors: {
        artifact: {
          bg: 'var(--app-bg)',
          panel: 'var(--panel-bg)',
          surface: 'var(--surface-2)',
          hover: 'var(--surface-3)',
          border: 'var(--border)',
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          muted: 'var(--text-muted)',
          accent: 'var(--accent)',
          'accent-subtle': 'var(--accent-subtle)',
          'accent-foreground': 'var(--on-accent)',
          success: 'var(--color-success)',
          error: 'var(--color-error)',
          warning: 'var(--color-warning)',
          'chart-1': 'var(--chart-1)',
          'chart-2': 'var(--chart-2)',
          'chart-3': 'var(--chart-3)',
          'chart-4': 'var(--chart-4)',
          'chart-5': 'var(--chart-5)'
        }
      }
    }
  }
}
