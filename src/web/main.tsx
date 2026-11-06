import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installStandalone } from '../app/install.ts';
import { App } from './App.tsx';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root');

/**
 * PatchPilot has no server: the UI is bundled into the APK and every `/api/...`
 * call is answered on the device by `installStandalone`. Outside the Android
 * shell there is nothing to talk to, so say so instead of failing obscurely.
 */
async function bootstrap(): Promise<void> {
  const installed = await installStandalone().catch((error: unknown) => {
    console.error('Standalone setup failed', error);
    return false;
  });

  if (!installed) {
    container!.innerHTML =
      '<div style="font:14px/1.6 system-ui;padding:32px;color:#e7eef7;background:#080b10;height:100vh">' +
      '<h1 style="font-size:18px;margin:0 0 8px">PatchPilot runs on Android</h1>' +
      '<p style="color:#93a3b8;margin:0">Install the APK from the releases page — this page has no server behind it.</p>' +
      '</div>';
    return;
  }

  createRoot(container as HTMLElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
