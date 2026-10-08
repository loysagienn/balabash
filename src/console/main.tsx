// Entry of the console SPA. The shell (src/api/console.ts) mounts it into
// #root; everything else — routing, data, screens — lives in the React tree.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('console: #root is missing from the shell');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
