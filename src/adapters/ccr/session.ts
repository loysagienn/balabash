// The CCR multiplexer: the one place that speaks the alpha bridge surface of
// @anthropic-ai/claude-agent-sdk. Owns the threadId ↔ cse_* mapping (the
// ccr_sessions table), worker JWT minting and refresh, epochs, SSE cursors
// and re-attach. Everything above it deals in threads and SDKMessage frames.
//
// Lifecycle of one managed session:
//   ensureSession(threadId, title)
//     → row lookup (create the cse_* session remotely when absent)
//     → fetchRemoteCredentials (mints the JWT; the call IS the worker
//       register — it bumps epoch, superseding any previous worker)
//     → attachBridgeSession with the persisted SSE cursor (resume-not-replay)
//   onClose(401)  — JWT expired: fresh credentials, re-attach with cursor
//   onClose(4090) — epoch superseded: re-attach reclaims the session
//   onClose(other) — permanent; surfaced through callbacks.onFatal
//
// Outcomes of the two authenticated bridge calls (createCodeSession /
// fetchRemoteCredentials), as classified by the SDK:
//   null                 — transient transport failure; plain retry
//   terminal: true       — CreateSessionFailure / CredentialsFailure; the same
//                          request will fail again (invalid_session_id is the
//                          self-healing trigger below)
//   terminal: false      — CredentialsRejection: the operator's OAuth bearer
//                          itself was rejected (401). Pointless with the SAME
//                          token, possible with a NEW one. Credentials are
//                          re-read from disk on every attempt (the CLI rotates
//                          them), so the ordinary backoff IS the retry-with-a-
//                          new-credential path; if the token never changes the
//                          operator has to log in again with the Claude CLI.
//
// The worker JWT lives ~8h (measured 2026-08 on the fork); a proactive refresh
// re-attaches before expiry so the operator never sees a dead session.
//
// Self-healing: the operator may delete a cse_* session from the app at any
// time. A credentials fetch for a deleted session fails terminally with
// invalid_session_id — the stale row is dropped and a fresh remote session
// is created under the same thread (the cursor starts over: the deleted
// stream is gone with the session).

import {
  attachBridgeSession,
  createCodeSession,
  fetchRemoteCredentials,
  isCreateSessionFailure,
  isCredentialsFailure,
  isCredentialsRejection,
} from '@anthropic-ai/claude-agent-sdk/bridge';
import type {
  AttachBridgeSessionOptions,
  BridgeSessionHandle,
  RemoteCredentials,
  SessionState,
} from '@anthropic-ai/claude-agent-sdk/bridge';
import type { SDKControlGetContextUsageResponse, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { prisma } from '../../db/client.ts';
import { resolveOperatorCredentials, tokenTtlMs } from './token.ts';
import type { OperatorCredentials } from './token.ts';

const BASE_URL = process.env.CCR_BASE_URL ?? 'https://api.anthropic.com';
const TIMEOUT_MS = 15_000;
const CURSOR_SAVE_INTERVAL_MS = 5_000;
const REATTACH_BACKOFF_MS = [1_000, 5_000, 15_000, 60_000, 300_000];
// Refresh the worker JWT well before its ~8h expiry.
const JWT_REFRESH_MARGIN_MS = 30 * 60_000;

export type ContextUsageOptions = { detail?: 'summary' | 'full' };

// The bridge forwards onGetContextUsage only through our patch
// (scripts/patch-sdk-bridge.mjs); the published typings do not declare it.
type AttachOptions = AttachBridgeSessionOptions & {
  onGetContextUsage?: (opts: ContextUsageOptions) => Promise<SDKControlGetContextUsageResponse>;
};

export type CcrCallbacks = {
  // A user frame arrived from the app. Errors are caught and journaled by
  // the implementation — the multiplexer only transports.
  onUserMessage(threadId: string, msg: SDKMessage): Promise<void>;
  // Stop button in the app.
  onInterrupt(threadId: string): void;
  // The session is permanently gone (terminal close, exhausted retries).
  onFatal(threadId: string, description: string): void;
  // The app asks for the context-window occupancy of the thread's session
  // (get_context_usage). Rejects when no live session can answer.
  onGetContextUsage(threadId: string, opts: ContextUsageOptions): Promise<SDKControlGetContextUsageResponse>;
};

type Managed = {
  threadId: string;
  cseId: string;
  // Session title, kept for self-healing: recreating a deleted session needs
  // the name it was created under.
  title: string;
  handle: BridgeSessionHandle | null;
  savedSeq: number;
  dead: boolean;
  reattachAttempt: number;
  refreshTimer: NodeJS.Timeout | null;
};

// Terminal marker of a deleted/unknown cse_* session — the self-healing
// trigger, distinguished from other terminal credential failures
// (untrusted_device etc.) which recreation cannot cure.
class SessionGoneError extends Error {
  constructor(cseId: string) {
    super(`CCR session ${cseId} no longer exists (invalid_session_id)`);
    this.name = 'SessionGoneError';
  }
}

export function isSessionGoneError(error: unknown): boolean {
  return error instanceof SessionGoneError;
}

// The bridge rejected the operator's OAuth bearer (CredentialsRejection). The
// message carries the remediation because this is the one failure only the
// operator can fix: re-authenticate with the Claude CLI on this box (or, for
// an env-provided token, replace CLAUDE_CODE_OAUTH_TOKEN).
class OAuthRejectedError extends Error {
  constructor(call: 'createCodeSession' | 'fetchRemoteCredentials', creds: OperatorCredentials) {
    const ttl = tokenTtlMs(creds);
    const minutes = ttl == null ? null : Math.round(Math.abs(ttl) / 60_000);
    const expiry = ttl == null ? 'expiry unknown' : ttl <= 0 ? `expired ${minutes}min ago` : `expires in ${minutes}min`;

    super(
      `${call}: the operator's OAuth token was rejected (source=${creds.source}, ${expiry}); ` +
        're-authenticate with the Claude CLI on this box — retrying with the same token cannot succeed',
    );
    this.name = 'OAuthRejectedError';
  }
}

// POST /v1/code/sessions with the operator's current token. Returns the cse_*
// id; every non-success outcome becomes a thrown error (see the header for
// the classification).
async function createRemoteSession(title: string): Promise<string> {
  const creds = await resolveOperatorCredentials();
  const created = await createCodeSession(BASE_URL, creds.accessToken, title, TIMEOUT_MS);

  if (created == null) {
    throw new Error('createCodeSession failed (transient HTTP failure)');
  }

  if (isCredentialsRejection(created)) {
    throw new OAuthRejectedError('createCodeSession', creds);
  }

  if (isCreateSessionFailure(created)) {
    throw new Error(`createCodeSession rejected: ${created.reason} ${created.status} ${created.detail ?? ''}`);
  }

  return created;
}

// Mint a worker JWT for a session (the call IS the worker register — it bumps
// the epoch). A deleted session surfaces as SessionGoneError so callers can
// self-heal; everything else non-success is a thrown error.
async function mintWorkerCredentials(cseId: string): Promise<RemoteCredentials> {
  const creds = await resolveOperatorCredentials();
  const remote = await fetchRemoteCredentials(
    cseId,
    BASE_URL,
    creds.accessToken,
    TIMEOUT_MS,
    creds.trustedDeviceToken ?? undefined,
  );

  if (remote == null) {
    throw new Error('fetchRemoteCredentials failed (transient failure)');
  }

  if (isCredentialsRejection(remote)) {
    throw new OAuthRejectedError('fetchRemoteCredentials', creds);
  }

  if (isCredentialsFailure(remote)) {
    if (remote.reason === 'invalid_session_id') {
      throw new SessionGoneError(cseId);
    }

    throw new Error(`fetchRemoteCredentials rejected terminally: ${remote.reason}`);
  }

  return remote;
}

// Headers of the session-management calls the CLI itself makes for a session
// (its updateSessionTitle / archiveRemoteSession): the operator's OAuth
// bearer plus the trusted-device token when the device is enrolled.
function sessionApiHeaders(creds: OperatorCredentials): Record<string, string> {
  return {
    Authorization: `Bearer ${creds.accessToken}`,
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    ...(creds.trustedDeviceToken ? { 'X-Trusted-Device-Token': creds.trustedDeviceToken } : {}),
  };
}

function sessionUrl(cseId: string, suffix = ''): string {
  return `${BASE_URL}/v1/code/sessions/${encodeURIComponent(cseId)}${suffix}`;
}

// PUT /v1/code/sessions/{id} {title} — the title sync the CLI does after its
// own /rename (measured from claude-code 2.1.273). Throws on any non-2xx.
export async function renameRemoteSession(cseId: string, title: string): Promise<void> {
  const creds = await resolveOperatorCredentials();
  const response = await fetch(sessionUrl(cseId), {
    method: 'PUT',
    headers: sessionApiHeaders(creds),
    body: JSON.stringify({ title }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`rename of ${cseId} failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
}

// POST /v1/code/sessions/{id}/archive — the session leaves the app's list
// (the CLI treats 200 and 409 "already archived" alike). 404 means the
// operator deleted the session: nothing left to archive. Throws otherwise.
export async function archiveRemoteSession(cseId: string): Promise<'archived' | 'gone'> {
  const creds = await resolveOperatorCredentials();
  const response = await fetch(sessionUrl(cseId, '/archive'), {
    method: 'POST',
    headers: sessionApiHeaders(creds),
    body: '{}',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (response.ok || response.status === 409) {
    return 'archived';
  }

  if (response.status === 404) {
    return 'gone';
  }

  throw new Error(`archive of ${cseId} failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
}

export class CcrMultiplexer {
  private sessions = new Map<string, Managed>();
  private cursorTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(private callbacks: CcrCallbacks) {}

  hasSession(threadId: string): boolean {
    const session = this.sessions.get(threadId);

    return Boolean(session && !session.dead);
  }

  /**
   * Bind a thread to its CCR session, creating the remote session if needed.
   * Returns whether the remote cse_* session was created by this call — a
   * fresh session gets an opener frame, a rebound one must not. When the
   * mapped session was deleted by the operator, a fresh one replaces it —
   * unless opts.recreate is false (a terminal-only delivery must not spawn a
   * junk session), in which case the SessionGoneError surfaces.
   */
  async ensureSession(
    threadId: string,
    title: string,
    opts: { recreate?: boolean } = {},
  ): Promise<{ created: boolean }> {
    const existing = this.sessions.get(threadId);

    if (existing && !existing.dead) {
      return { created: false };
    }

    // A dead entry (terminal close, exhausted retries) does not block a fresh
    // bind: replace it and go through the full attach machinery again.
    if (existing) {
      this.sessions.delete(threadId);
    }

    let row = await prisma.ccrSession.findUnique({ where: { threadId } });
    let createdRemote = false;

    if (!row) {
      const created = await createRemoteSession(title);

      row = await prisma.ccrSession.create({ data: { threadId, cseId: created, seqCursor: 0 } });
      createdRemote = true;
    }

    const managed: Managed = {
      threadId,
      cseId: row.cseId,
      title,
      handle: null,
      savedSeq: row.seqCursor,
      dead: false,
      reattachAttempt: 0,
      refreshTimer: null,
    };

    this.sessions.set(threadId, managed);

    try {
      await this.attach(managed);
    } catch (error) {
      // A failed first attach must not leave a handle-less zombie behind:
      // the row persists, the next ensureSession retries the bind.
      this.sessions.delete(threadId);

      // Self-healing: the operator deleted this session from the app. Drop
      // the stale mapping and bind the thread to a fresh remote session —
      // one level deep only (createdRemote guards the recursion: a session
      // we just created cannot be the stale one).
      if (error instanceof SessionGoneError && !createdRemote && opts.recreate !== false) {
        console.log(`[ccr] session for thread=${threadId} was deleted by the operator — recreating`);
        await prisma.ccrSession.delete({ where: { threadId } }).catch(() => {});

        return this.ensureSession(threadId, title);
      }

      throw error;
    }

    this.startCursorTimer();

    return { created: createdRemote };
  }

  write(threadId: string, frame: SDKMessage): boolean {
    const handle = this.liveHandle(threadId);

    if (!handle) {
      return false;
    }

    handle.write(frame);

    return true;
  }

  sendResult(threadId: string): void {
    this.liveHandle(threadId)?.sendResult();
  }

  reportState(threadId: string, state: SessionState): void {
    this.liveHandle(threadId)?.reportState(state);
  }

  // external_metadata of the session (what the app shows next to it: the
  // post_turn_summary status chip and the like).
  reportMetadata(threadId: string, metadata: Record<string, unknown>): void {
    this.liveHandle(threadId)?.reportMetadata(metadata);
  }

  /**
   * Rename the thread's remote session — the title in the operator's app.
   * The managed title follows so a self-healing recreation keeps the new
   * name; a thread not managed right now is renamed through its row.
   */
  async rename(threadId: string, title: string): Promise<void> {
    const managed = this.sessions.get(threadId);
    const cseId = managed?.cseId ?? (await prisma.ccrSession.findUnique({ where: { threadId } }))?.cseId;

    if (!cseId) {
      return;
    }

    await renameRemoteSession(cseId, title);

    if (managed) {
      managed.title = title;
    }
  }

  /**
   * Detach a thread's session and forget it (a terminal delivered its final
   * frame): the cursor is persisted, the remote cse_* session stays as the
   * operator's readable archive. Idempotent.
   */
  async release(threadId: string): Promise<void> {
    const managed = this.sessions.get(threadId);

    if (!managed) {
      return;
    }

    this.sessions.delete(threadId);
    managed.dead = true;

    if (managed.refreshTimer) {
      clearTimeout(managed.refreshTimer);
      managed.refreshTimer = null;
    }

    const handle = managed.handle;

    managed.handle = null;

    if (handle) {
      const seq = handle.getSequenceNum();

      await handle.flush().catch(() => {});
      handle.close();
      await prisma.ccrSession
        .update({ where: { threadId }, data: { seqCursor: seq } })
        .catch(error => console.error(`[ccr] cursor save on release failed thread=${threadId}:`, error));
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;

    if (this.cursorTimer) {
      clearInterval(this.cursorTimer);
      this.cursorTimer = null;
    }

    for (const managed of this.sessions.values()) {
      if (managed.refreshTimer) {
        clearTimeout(managed.refreshTimer);
        managed.refreshTimer = null;
      }

      const handle = managed.handle;

      managed.handle = null;

      if (handle) {
        await handle.flush().catch(() => {});
        handle.close();
      }
    }

    await this.saveCursors().catch(error => {
      console.error('[ccr] failed to save cursors on stop:', error);
    });
    this.sessions.clear();
  }

  // -------------------------------------------------------------------------

  private liveHandle(threadId: string): BridgeSessionHandle | null {
    const session = this.sessions.get(threadId);

    return session && !session.dead ? session.handle : null;
  }

  private async attach(managed: Managed): Promise<void> {
    const remote = await mintWorkerCredentials(managed.cseId);

    const options: AttachOptions = {
      sessionId: managed.cseId,
      ingressToken: remote.worker_jwt,
      apiBaseUrl: remote.api_base_url,
      epoch: remote.worker_epoch,
      initialSequenceNum: managed.savedSeq,
      onInboundMessage: async msg => {
        await this.callbacks.onUserMessage(managed.threadId, msg);
      },
      onInterrupt: () => {
        this.callbacks.onInterrupt(managed.threadId);
      },
      // Control requests the CCR plane does not support — polite,
      // explicit refusals instead of silent false-success.
      onSetModel: () => ({ ok: false, error: 'Model is managed by Balabash, not per session.' }),
      onSetPermissionMode: () => ({
        ok: false,
        error: 'Permission mode is managed by Balabash, not per session.',
      }),
      onRenameSession: () => ({ ok: false, error: 'Session titles are managed by Balabash.' }),
      onGetContextUsage: opts => this.callbacks.onGetContextUsage(managed.threadId, opts),
      onClose: code => {
        void this.handleClose(managed, code);
      },
    };

    managed.handle = await attachBridgeSession(options);

    managed.reattachAttempt = 0;
    this.scheduleJwtRefresh(managed, remote.expires_in * 1000);
    console.log(
      `[ccr] attached thread=${managed.threadId} cse=${managed.cseId} seq=${managed.savedSeq} epoch=${remote.worker_epoch}`,
    );
  }

  // Proactive JWT refresh: re-mint credentials and swap the transport in
  // place before the 401 ever fires. reconnectTransport keeps the SSE cursor;
  // the epoch moves forward because minting is registering.
  private scheduleJwtRefresh(managed: Managed, expiresInMs: number): void {
    if (managed.refreshTimer) {
      clearTimeout(managed.refreshTimer);
    }

    const delay = Math.max(60_000, expiresInMs - JWT_REFRESH_MARGIN_MS);

    managed.refreshTimer = setTimeout(() => {
      void (async () => {
        if (this.stopping || managed.dead || !managed.handle) {
          return;
        }

        try {
          // Any non-success (transient, terminal, session gone, OAuth
          // rejected) throws and lands in the full re-attach machinery
          // below, which classifies it properly.
          const remote = await mintWorkerCredentials(managed.cseId);

          await managed.handle.reconnectTransport({
            ingressToken: remote.worker_jwt,
            apiBaseUrl: remote.api_base_url,
            epoch: remote.worker_epoch,
          });
          this.scheduleJwtRefresh(managed, remote.expires_in * 1000);
          console.log(`[ccr] refreshed JWT thread=${managed.threadId} epoch=${remote.worker_epoch}`);
        } catch (error) {
          // The reconnect path failed — drop the handle and go through the
          // full re-attach machinery instead.
          console.error(`[ccr] JWT refresh failed thread=${managed.threadId}:`, error);
          managed.handle?.close();
          managed.handle = null;
          void this.reattach(managed);
        }
      })();
    }, delay);
  }

  private async handleClose(managed: Managed, code: number | undefined): Promise<void> {
    if (this.stopping || managed.dead) {
      return;
    }

    console.error(`[ccr] transport closed thread=${managed.threadId} code=${code}`);
    managed.savedSeq = managed.handle?.getSequenceNum() ?? managed.savedSeq;
    managed.handle = null;

    // 401 — JWT expired; 4090 — epoch superseded (a stale worker raced us;
    // re-registering reclaims the session); 4094 — the worker credential
    // expired or was rejected on the request path ("re-attach with a fresh
    // secret, like 401" per bridge.d.ts); 4093 — presence heartbeats kept
    // failing while the stream was healthy ("transport self-heal
    // candidate"). All recoverable by a fresh mint + attach; anything else
    // (4091 init failed, 4092 codeless, 403/404) is permanent.
    if (code === 401 || code === 4090 || code === 4093 || code === 4094) {
      await this.reattach(managed);

      return;
    }

    this.markDead(managed, `CCR transport closed permanently (code=${code ?? 'unknown'})`);
  }

  private async reattach(managed: Managed): Promise<void> {
    let lastError: unknown = null;

    while (!this.stopping && !managed.dead) {
      const backoff = REATTACH_BACKOFF_MS[Math.min(managed.reattachAttempt, REATTACH_BACKOFF_MS.length - 1)]!;

      managed.reattachAttempt += 1;

      if (managed.reattachAttempt > REATTACH_BACKOFF_MS.length) {
        const cause = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown');

        this.markDead(managed, `CCR re-attach failed after ${REATTACH_BACKOFF_MS.length} attempts: ${cause}`);

        return;
      }

      await new Promise(resolve => setTimeout(resolve, backoff));

      try {
        await this.attach(managed);

        return;
      } catch (error) {
        lastError = error;
        console.error(`[ccr] re-attach attempt ${managed.reattachAttempt} failed thread=${managed.threadId}:`, error);

        // An OAuthRejectedError is retried on purpose: every attach re-reads
        // the credentials file, and the CLI may rotate the token meanwhile.
        // If it never does, the attempts run out and the fatal description
        // above tells the operator to log in again.
        //
        // Self-healing mid-run: the operator deleted the session while the
        // thread lives. Rebind to a fresh remote session; the next loop
        // iteration attaches to it (failures fall back into the ordinary
        // backoff).
        if (error instanceof SessionGoneError) {
          await this.recreate(managed).catch(recreateError => {
            console.error(`[ccr] session recreation failed thread=${managed.threadId}:`, recreateError);
          });
        }
      }
    }
  }

  // Bind a live Managed to a brand-new remote session after the old one was
  // deleted from the app: fresh cse_*, cursor from zero (the deleted stream
  // died with the session).
  private async recreate(managed: Managed): Promise<void> {
    await prisma.ccrSession.delete({ where: { threadId: managed.threadId } }).catch(() => {});

    const created = await createRemoteSession(managed.title);

    await prisma.ccrSession.create({ data: { threadId: managed.threadId, cseId: created, seqCursor: 0 } });
    managed.cseId = created;
    managed.savedSeq = 0;
    console.log(`[ccr] recreated deleted session thread=${managed.threadId} → cse=${created}`);
  }

  private markDead(managed: Managed, description: string): void {
    managed.dead = true;

    if (managed.refreshTimer) {
      clearTimeout(managed.refreshTimer);
      managed.refreshTimer = null;
    }

    this.callbacks.onFatal(managed.threadId, description);
  }

  private startCursorTimer(): void {
    if (this.cursorTimer) {
      return;
    }

    this.cursorTimer = setInterval(() => {
      void this.saveCursors().catch(error => {
        console.error('[ccr] cursor save failed:', error);
      });
    }, CURSOR_SAVE_INTERVAL_MS);
  }

  private async saveCursors(): Promise<void> {
    for (const managed of this.sessions.values()) {
      const seq = managed.handle?.getSequenceNum() ?? managed.savedSeq;

      if (seq !== managed.savedSeq) {
        managed.savedSeq = seq;
        await prisma.ccrSession.update({ where: { threadId: managed.threadId }, data: { seqCursor: seq } });
      }
    }
  }
}
