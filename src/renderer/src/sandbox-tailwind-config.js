window.tailwind = window.tailwind || {}
window.tailwind.config = {
  theme: {
    extend: {
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
          'accent-foreground': 'var(--on-accent)',
          success: 'var(--color-success)',
          error: 'var(--color-error)',
          warning: 'var(--color-warning)'
        }
      }
    }
  }
}
