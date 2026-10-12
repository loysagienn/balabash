// A claude.ai connector of the installation (the catalog's tile): an
// external server reached through Anthropic's MCP proxy, whose authorization
// with the provider lives in the operator's claude.ai account and whose one
// local dependency is the operator's Claude CLI login on this box. Nothing
// to provide or forget here — the dialog only says the state and where the
// connector is managed: connected; the CLI token expired (calls fail until
// a Claude Code session on the box rotates it); the connection failed (why).

import type { ConnectorServiceView } from '../../../api/contract.ts';
import { useNow } from '../../lib/format/useNow.ts';
import { startedLabel } from '../../lib/format/index.ts';
import { Dialog } from '../../ui/Dialog/Dialog.tsx';
import { Note } from '../../ui/Note/Note.tsx';

export function ConnectorServiceDialog({ service, onClose }: { service: ConnectorServiceView; onClose: () => void }) {
  const now = useNow();

  return (
    <Dialog title={service.name} cancel="Close" onClose={onClose}>
      <div className="form">
        {service.state === 'connected' ? (
          <Note icon="circle-check">Connected through claude.ai. Its tools serve every workspace of this installation.</Note>
        ) : service.state === 'token_expired' ? (
          <Note state="act" icon="clock-alert">
            The Claude CLI token on this box expired{service.tokenExpiresAt ? ` ${startedLabel(service.tokenExpiresAt, now)}` : ''}: calls fail until a Claude Code session on the box
            rotates it. Nothing needs re-authorizing.
          </Note>
        ) : (
          <Note state="err" icon="triangle-alert">
            Couldn’t connect: {service.error}
          </Note>
        )}
        {service.description ? <p className="conn-connect-note">{service.description}</p> : null}
        <p className="conn-connect-note">
          Managed on claude.ai: the authorization with the provider is the operator’s claude.ai connector, reached through Anthropic’s MCP proxy on the Claude CLI login of this box. To
          connect a different account or disconnect it, use claude.ai’s connector settings; to remove it from Balabash, delete its file in data/mcp-servers.
        </p>
      </div>
    </Dialog>
  );
}
