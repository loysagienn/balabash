// "Update the extension on …": how the extension of a browser of the user
// is brought to the version the installation hands out — the archive is
// unpacked over the folder Chrome loads the extension from, on the
// computer that browser runs on. The dialog's action downloads the archive
// here (GET /api/browsers/extension.zip); the dialog stays for the steps.

import type { BrowserView } from '../../../api/contract.ts';
import { extensionArchiveUrl } from '../../lib/api/index.ts';
import { Dialog } from '../../ui/Dialog/Dialog.tsx';
import { Code, Quiet } from '../../ui/atoms/atoms.tsx';

export function UpdateExtensionDialog({ browser, here, current, onClose }: { browser: BrowserView; here: boolean; current: string; onClose: () => void }) {
  return (
    <Dialog
      title={`Update the extension on “${browser.name}”`}
      confirm={`Download ${current}`}
      confirmIcon="download"
      cancel="Close"
      onConfirm={() => window.location.assign(extensionArchiveUrl())}
      onClose={onClose}
    >
      <ol className="brw-steps">
        <li>
          <span>
            <b>Get {current} onto {here ? 'this' : 'that'} computer.</b>{' '}
            <Quiet>{here ? 'Download it here.' : 'Download it here and move it over, or open Connections in that Chrome and download it there.'}</Quiet>
          </span>
        </li>
        <li>
          <span>
            <b>Unzip it over the old folder.</b> <Quiet>The same place Chrome loads the extension from now.</Quiet>
          </span>
        </li>
        <li>
          <span>
            <b>Press Reload.</b>{' '}
            <Quiet>
              On Balabash Agent in <Code>chrome://extensions</Code>. Its connection and settings stay.
            </Quiet>
          </span>
        </li>
      </ol>
    </Dialog>
  );
}
