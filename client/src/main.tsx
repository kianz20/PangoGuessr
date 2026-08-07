import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

// NOTE (§7): StrictMode double-mounts effects in development. Harmless here, but it
// silently doubles every Street View panorama load — revisit this when the viewer lands.
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
