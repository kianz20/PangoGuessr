import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { readHandoff } from './session';
// Bundled rather than fetched from a font CDN: one less origin, and it works offline.
import '@fontsource-variable/fredoka/wght.css';
import 'leaflet/dist/leaflet.css';
import './styles.css';

// Must run before anything calls getSessionId(): it may adopt the hub's player id.
readHandoff();

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

// NOTE (§7): StrictMode double-mounts effects in development. That would double every
// Street View load, except that viewers live in panoramas.ts and a remount reuses them.
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
