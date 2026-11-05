import { createRoot } from 'react-dom/client'
import { AnnotationOverlay } from './AnnotationOverlay'
import '../styles/App.css'
import './annotationOverlay.css'

createRoot(document.getElementById('root')!).render(<AnnotationOverlay />)
