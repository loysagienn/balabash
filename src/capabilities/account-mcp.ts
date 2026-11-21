// A 401 explicitly refuses the credential. Renew that account's token once.
// Other failures, including an uncertain outcome, never repeat the exchange.
import { CapabilityError, type AccountAuthority } from '../catalog/index.ts';
import { CredentialsRefusedError } from './mcp-client.ts';

export async function withAccountBearer<T>(
  title: string, account: string, authority: AccountAuthority, signal: AbortSignal | null,
  exchange: (token: string) => Promise<T>,
): Promise<T> {
  async function send(token: string) {
    try {
      return await exchange(token);
    } catch (error) {
      // Providers can echo an Authorization header in their HTTP error body.
      if (token && error instanceof Error) error.message = error.message.replaceAll(token, '[redacted]');
      throw error;
    }
  }
  const token = await authority.accessToken();
  try {
    return await send(token);
  } catch (error) {
    if (!(error instanceof CredentialsRefusedError) || signal?.aborted) throw error;
    const renewed = await authority.accessToken(token);
    try {
      return await send(renewed);
    } catch (retryError) {
      if (!(retryError instanceof CredentialsRefusedError)) throw retryError;
      throw new CapabilityError('auth_required', `${title} refused the renewed token. Re-authorize account "${account}".`);
    }
  }
}
