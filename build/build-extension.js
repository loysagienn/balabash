// `npm run build-extension`: the browser extension alone
// (build/browser-extension.js).

import { buildInstallationExtension } from './browser-extension.js';

if (!(await buildInstallationExtension())) {
  console.error(
    'The browser extension is built for one installation and needs its console domain: ' +
      'set CONSOLE_DOMAIN in .env or run CONSOLE_DOMAIN=<domain> npm run build-extension.',
  );
  process.exit(1);
}
