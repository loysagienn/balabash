// The words of the Connections screen, pure: the state and label of an
// account's badge, its meta line, the scopes as chips, the primary action
// of a row, the banner of an account that needs sign-in, the catalog's
// counts and whether a service takes another account, a service of the
// installation's state and link, the order of the catalog, the checks of
// the two forms.

import type { ConnectionView, ConnectorServiceView, InstallationServiceView, ServiceView } from '../../../api/contract.ts';
import type { IconName } from '../../ui/Icon/Icon.tsx';
import type { StateName } from '../../ui/atoms/atoms.tsx';
import type { ConnectionLink } from '../../store/connections/reducer.ts';
import { countOf, dateTimeLabel, shortDate } from '../../lib/format/index.ts';

export const NAME_MAX_LENGTH = 200;

// Whether a service's first sign-in waits for Balabash's own OAuth client
// at the provider: a manual client the server reports missing. A snapshot
// of a build without the field says nothing — the dialog offers the link
// and the server's refusal speaks.
export function clientMissing(service: ServiceView): boolean {
  return service.manualClient && service.clientProvisioned === false;
}

// The six-state palette over the row's status (the design: connected ·
// pending · needs sign-in); a status the console does not know is shown
// as it is, in the quiet state.
export function statusWords(status: string): { state: StateName; label: string } {
  switch (status) {
    case 'connected':
      return { state: 'done', label: 'connected' };
    case 'pending':
      return { state: 'wait', label: 'pending' };
    case 'reauthorization_required':
      return { state: 'act', label: 'needs sign-in' };
    default:
      return { state: 'off', label: status };
  }
}

// The object icon's tint: only a state that asks something of the user.
export function objState(status: string): StateName | undefined {
  const { state } = statusWords(status);

  return state === 'done' ? undefined : state;
}

// A service's icon by its name — the design's icons for the services it
// drew; any other service is a plug.
export function serviceIcon(server: string): IconName {
  const name = server.toLowerCase();

  if (name.includes('notion')) {
    return 'book-open';
  }

  if (name.includes('mail')) {
    return 'mail';
  }

  if (name.includes('calendar')) {
    return 'calendar-days';
  }

  if (name.includes('drive')) {
    return 'hard-drive';
  }

  if (name.includes('todoist')) {
    return 'list-checks';
  }

  if (name.includes('yandex') || name.includes('direct')) {
    return 'megaphone';
  }

  if (name.includes('github') || name.includes('gitlab')) {
    return 'git-fork';
  }

  if (name.includes('perplexity')) {
    return 'search';
  }

  if (name.includes('qase')) {
    return 'list-todo';
  }

  if (name.includes('slack')) {
    return 'messages-square';
  }

  return 'plug';
}

// "notion · v@example.com · since Sep 3" — the service, who the account is
// at the provider (its address until the identity is known), and since
// when it is connected; a pending account names when its link was issued.
export function accountMeta(connection: ConnectionView, now: Date): string {
  const who = connection.identity ?? connection.accountKey;
  const parts = [connection.server, who];

  if (connection.status === 'pending') {
    parts.push(`link issued ${dateTimeLabel(connection.updatedAt, now)}`);
  } else {
    parts.push(`since ${shortDate(connection.createdAt, now)}`);
  }

  return parts.join(' · ');
}

// The granted permissions as the provider spelled them: one chip per
// scope, split on whitespace or commas.
export function scopeList(scope: string | null): string[] {
  return scope ? scope.split(/[\s,]+/).filter(Boolean) : [];
}

export function linkAlive(link: ConnectionLink | null, now: Date): link is ConnectionLink {
  return link !== null && link.expiresAt.getTime() > now.getTime();
}

export type RowAction = { kind: 'open'; label: string; url: string } | { kind: 'reconnect'; label: string };

// The button of a row: a held link is opened; an account that needs
// sign-in asks for one; a pending account whose link this tab does not
// hold (or holds expired) gets a new one; a connected account has no
// button — its "Reconnect" is in the menu.
export function rowAction(connection: ConnectionView, link: ConnectionLink | null, now: Date): RowAction | null {
  if (linkAlive(link, now)) {
    return { kind: 'open', label: 'Open sign-in', url: link.url };
  }

  switch (connection.status) {
    case 'reauthorization_required':
      return { kind: 'reconnect', label: 'Sign in' };
    case 'pending':
      return { kind: 'reconnect', label: 'New link' };
    default:
      return null;
  }
}

// The description line of a pending account without a scope to show.
export function pendingWords(connection: ConnectionView, link: ConnectionLink | null, now: Date): string | null {
  if (connection.status !== 'pending') {
    return null;
  }

  return linkAlive(link, now) ? `Sign in at ${connection.server} to finish — the account turns connected here on its own.` : `Sign-in not finished. Get a new link to continue; a link an agent sent in the chat still works until it expires.`;
}

// The banner over the list for an account whose authorization the
// provider no longer accepts.
export function needsSignInWords(connection: ConnectionView): string {
  return `${connection.server} “${connection.displayName}”: sign-in required again — the provider no longer accepts its authorization. Agents can’t use this account until you sign in.`;
}

export function accountsOf(connections: ConnectionView[], server: string): ConnectionView[] {
  return connections.filter(connection => connection.server === server);
}

// "2 accounts" / "not connected" — the tile's footer.
export function catalogCount(n: number): string {
  return n === 0 ? 'not connected' : countOf(n, 'account');
}

// A service of the installation in the catalog: the footer's words (the
// credentials are one set for every workspace) and the tile's link — "Set
// up" while a credential is missing, "Manage" otherwise.
export function installationWords(service: Pick<InstallationServiceView, 'state'>): { label: string; link: string; state: StateName | undefined } {
  switch (service.state) {
    case 'connected':
      return { label: 'connected · installation-wide', link: 'Manage', state: undefined };
    case 'failed':
      return { label: 'connection failed', link: 'Manage', state: 'err' };
    default:
      return { label: 'not set up', link: 'Set up', state: undefined };
  }
}

// A claude.ai connector in the catalog: read-only — its authorization is
// the operator's claude.ai account, so the tile says the state and opens
// the details ("Details"), never a credentials flow.
export function connectorWords(service: Pick<ConnectorServiceView, 'state'>): { label: string; state: StateName | undefined } {
  switch (service.state) {
    case 'connected':
      return { label: 'connected · via claude.ai', state: undefined };
    case 'token_expired':
      return { label: 'Claude CLI token expired', state: 'act' };
    default:
      return { label: 'connection failed', state: 'err' };
  }
}

// The catalog is one list: the services of per-user accounts, the services
// of the installation and its claude.ai connectors, by name.
export type CatalogEntry =
  | { kind: 'accounts'; service: ServiceView }
  | { kind: 'installation'; service: InstallationServiceView }
  | { kind: 'connector'; service: ConnectorServiceView };

export function catalogEntries(services: readonly ServiceView[], installation: readonly InstallationServiceView[], connectors: readonly ConnectorServiceView[] = []): CatalogEntry[] {
  return [
    ...services.map(service => ({ kind: 'accounts' as const, service })),
    ...installation.map(service => ({ kind: 'installation' as const, service })),
    ...connectors.map(service => ({ kind: 'connector' as const, service })),
  ].sort((a, b) => a.service.name.localeCompare(b.service.name));
}

// Whether the service takes another account: a service of several
// accounts always, a service of one only while it has none (the server
// refuses otherwise — its existing account is re-authorized from its row).
export function canConnect(service: ServiceView, accounts: number): boolean {
  return service.multiAccount || accounts === 0;
}

// The "Connect" form: a name is the operator's choice for the first account
// (the service's name otherwise) and a must once the service has one.
export function nameRequired(service: ServiceView, accounts: number): boolean {
  return service.multiAccount && accounts > 0;
}

export function nameHint(service: ServiceView, accounts: number): string {
  if (nameRequired(service, accounts)) {
    return `${service.name} already has ${countOf(accounts, 'account')}: name this one so agents can tell them apart.`;
  }

  return `Optional — “${service.name}” when empty. Agents see this name when they pick an account.`;
}

export function validateConnectName(name: string, required: boolean): string | null {
  const trimmed = name.trim();

  if (required && !trimmed) {
    return 'Required.';
  }

  return trimmed.length > NAME_MAX_LENGTH ? `At most ${NAME_MAX_LENGTH} characters.` : null;
}

export function validateRename(name: string): string | null {
  const trimmed = name.trim();

  if (!trimmed) {
    return 'Required.';
  }

  return trimmed.length > NAME_MAX_LENGTH ? `At most ${NAME_MAX_LENGTH} characters.` : null;
}
