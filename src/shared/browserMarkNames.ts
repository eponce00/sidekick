/**
 * What a marked part of a page is, in plain words for the user: "Heading", "Link", "Image".
 * Accessibility roles say it best; an element without one is named by its tag.
 */
const ROLE_KINDS: Record<string, string> = {
  article: 'Article',
  banner: 'Header',
  button: 'Button',
  cell: 'Table cell',
  checkbox: 'Checkbox',
  columnheader: 'Column header',
  combobox: 'Menu',
  complementary: 'Sidebar',
  contentinfo: 'Footer',
  dialog: 'Dialog',
  figure: 'Figure',
  form: 'Form',
  heading: 'Heading',
  image: 'Image',
  img: 'Image',
  link: 'Link',
  list: 'List',
  listitem: 'List item',
  main: 'Main content',
  menu: 'Menu',
  menuitem: 'Menu item',
  navigation: 'Navigation',
  option: 'Option',
  paragraph: 'Text',
  radio: 'Option',
  region: 'Section',
  row: 'Table row',
  rowheader: 'Row header',
  searchbox: 'Search field',
  slider: 'Slider',
  switch: 'Switch',
  tab: 'Tab',
  table: 'Table',
  tablist: 'Tabs',
  textbox: 'Text field',
  toolbar: 'Toolbar',
  video: 'Video'
}

const TAG_KINDS: Record<string, string> = {
  a: 'Link',
  article: 'Article',
  aside: 'Sidebar',
  button: 'Button',
  canvas: 'Canvas',
  figure: 'Figure',
  footer: 'Footer',
  form: 'Form',
  h1: 'Heading',
  h2: 'Heading',
  h3: 'Heading',
  h4: 'Heading',
  h5: 'Heading',
  h6: 'Heading',
  header: 'Header',
  iframe: 'Embedded page',
  img: 'Image',
  input: 'Field',
  label: 'Label',
  li: 'List item',
  main: 'Main content',
  nav: 'Navigation',
  ol: 'List',
  p: 'Text',
  picture: 'Image',
  section: 'Section',
  select: 'Menu',
  span: 'Text',
  svg: 'Icon',
  table: 'Table',
  td: 'Table cell',
  textarea: 'Text field',
  th: 'Table header',
  tr: 'Table row',
  ul: 'List',
  video: 'Video'
}

export function browserMarkKind(role?: string, tag?: string): string {
  return (
    (role && ROLE_KINDS[role.toLowerCase()]) ||
    (tag && TAG_KINDS[tag.toLowerCase()]) ||
    (tag ? 'Block' : 'Element')
  )
}

/** A mark's name: its kind, and what it says when it says anything, as `Heading “Almost…”`. */
export function browserMarkName(element: {
  role?: string
  tag?: string
  accessibleName?: string
  text?: string
}): string {
  const kind = browserMarkKind(element.role, element.tag)
  const said = (element.accessibleName || element.text || '').replace(/\s+/g, ' ').trim()
  if (!said) return kind
  return `${kind} “${said.length > 48 ? `${said.slice(0, 47).trimEnd()}…` : said}”`
}
