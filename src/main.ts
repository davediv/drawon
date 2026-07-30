import '@fontsource-variable/archivo/wdth.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles.css';

import { App } from './app';

try {
  new App();
} catch (error) {
  console.error('Drawone failed to start', error);
  const gate = document.getElementById('gate');
  const title = document.getElementById('gate-title');
  const body = document.getElementById('gate-body');
  const action = document.getElementById('gate-action');
  if (gate && title && body) {
    gate.hidden = false;
    title.textContent = 'Drawone could not start';
    body.textContent = error instanceof Error ? error.message : 'Unknown error.';
    if (action) action.hidden = true;
  }
}
