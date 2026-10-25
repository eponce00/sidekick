import { createRoot } from 'react-dom/client'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import { AnnotationOverlay } from './AnnotationOverlay'
import '../styles/App.css'
import './annotationOverlay.css'

createRoot(document.getElementById('root')!).render(<AnnotationOverlay />)
