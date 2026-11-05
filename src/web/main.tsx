import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installStandalone } from '../app/install.ts';
import { App } from './App.tsx';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root');

/**
 * Inside the Android app the API has no server behind it: `installStandalone`
 * wires the in-page backend before the first render, so every `/api/...` call
 * the UI makes is answered on the device. On a desktop it returns immediately
 * and the app talks to Node as usual.
 */
async function bootstrap(): Promise<void> {
  try {
    await installStandalone();
  } catch (error) {
    // A broken shell must not leave a blank screen; the UI's own error state
    // will explain that the server cannot be reached.
    console.error('Standalone setup failed', error);
  }

  createRoot(container as HTMLElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
