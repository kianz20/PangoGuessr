import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { adoptHandoffSession } from './session';
import 'leaflet/dist/leaflet.css';
import './styles.css';

// Must run before anything calls getSessionId().
adoptHandoffSession();

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

// NOTE (§7): StrictMode double-mounts effects in development. Harmless here, but it
// silently doubles every Street View panorama load — revisit this when the viewer lands.
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
