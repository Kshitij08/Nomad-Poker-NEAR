/**
 * The economy module's line to the Nomad server: the account module's NomadSession, bound at install when an API is
 * configured. Friends, invites, profile and leaderboards go through it; without one they are unavailable (offline).
 */
import type { NomadSession } from '../account/session';

let session: NomadSession | null = null;

export const NomadLink = {
  bind(s: NomadSession | null): void {
    session = s;
  },
  get session(): NomadSession | null {
    return session;
  },
  /** A Nomad server is configured (signed in or not). */
  get configured(): boolean {
    return session !== null;
  },
  get signedIn(): boolean {
    return !!session?.signedIn;
  },
  /** An authenticated call; throws when there is no server or the call fails (ApiRequestError). */
  call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!session) return Promise.reject(new Error('No Nomad server is configured.'));
    return session.call<T>(method, path, body);
  },
};
