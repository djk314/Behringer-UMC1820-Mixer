import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

function isBrowserExtensionError(reasonOrError: unknown, filename?: string): boolean {
  if (typeof filename === 'string' && filename.startsWith('chrome-extension://')) {
    return true;
  }
  if (reasonOrError && typeof reasonOrError === 'object') {
    const stack = (reasonOrError as { stack?: unknown }).stack;
    if (typeof stack === 'string' && stack.includes('chrome-extension://')) {
      return true;
    }
  }
  const text = String(reasonOrError ?? '');
  return text.includes('chrome-extension://') || text.includes('Talisman extension');
}

window.addEventListener(
  'unhandledrejection',
  (event) => {
    if (isBrowserExtensionError(event.reason)) {
      event.preventDefault();
    }
  },
  true,
);

window.addEventListener(
  'error',
  (event) => {
    if (isBrowserExtensionError(event.error ?? event.message, event.filename)) {
      event.preventDefault();
    }
  },
  true,
);

createRoot(document.getElementById('root')!).render(<App />);
