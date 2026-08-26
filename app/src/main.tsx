/* SPDX-License-Identifier: GPL-3.0-or-later */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './styles/base.css';

/*
 * Inside Tauri the window itself is an NSVisualEffectView, so the app must be
 * TRANSPARENT and let the real material show through. In a plain browser there
 * is no such layer, so the CSS material stands in. One attribute switches
 * between them; nothing else in the stylesheet needs to know.
 */
if ('__TAURI_INTERNALS__' in window || '__TAURI__' in window) {
  document.documentElement.dataset.shell = 'tauri';
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
