/**
 * The process-wide PlayFab client (the SDK's static PlayFabClientAPI + PlayFabSettings), configured once by the
 * economy module's install() for the chosen backend. Null in offline mode: every PlayFab-backed function then
 * behaves as "not signed in", exactly like the Unity code before a login.
 */
import type { PlayFabClient } from './client';

let client: PlayFabClient | null = null;

export function configurePlayFab(next: PlayFabClient | null): void {
  client = next;
}

export function playFab(): PlayFabClient | null {
  return client;
}

/** PlayFabClientAPI.IsClientLoggedIn(). */
export function isClientLoggedIn(): boolean {
  return !!client && client.isClientLoggedIn();
}
