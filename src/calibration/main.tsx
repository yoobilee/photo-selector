import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './calibration.css'
import CalibrationApp from './CalibrationApp.tsx'

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Root element #root not found')
}

createRoot(rootElement).render(
  <StrictMode>
    <CalibrationApp />
  </StrictMode>,
)
