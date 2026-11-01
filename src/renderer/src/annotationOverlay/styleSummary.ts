import type {
  AnnotationStyleProperty,
  AnnotationStyleValues
} from '../../../shared/annotationOverlay'

const NAMES: Record<AnnotationStyleProperty, string> = {
  'font-size': 'text size',
  'font-family': 'font',
  'font-weight': 'weight',
  color: 'text color',
  'background-color': 'background',
  opacity: 'opacity'
}

/** The kept changes in words, for the note the agent reads: "Style: text size 20px, …". */
export function styleSummary(styled: AnnotationStyleValues): string {
  const parts = (Object.entries(styled) as Array<[AnnotationStyleProperty, string]>)
    .filter(([, value]) => value)
    .map(([property, value]) =>
      property === 'font-family'
        ? `font ${value.split(',')[0].replace(/'/g, '')}`
        : `${NAMES[property]} ${value}`
    )
  return parts.length ? `Style: ${parts.join(', ')}` : ''
}
