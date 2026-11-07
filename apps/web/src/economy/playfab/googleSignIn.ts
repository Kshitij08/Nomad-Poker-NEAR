/**
 * Port of Economy/PokerGoogleSignIn.cs + Plugins/WebGL/PokerGoogleSignIn.jslib: Google Identity Services →
 * OAuth access token for PlayFab LoginWithGoogleAccount (initTokenClient, not initCodeClient: PlayFab cannot
 * exchange "postmessage" auth codes).
 *
 * Only in live mode: loading accounts.google.com is a network call to a third party, so offline / local modes
 * answer like the Unity Editor did ("Google sign-in runs in the WebGL build").
 */
import { PlayFabConfig } from '../config';
import { playFab } from './runtime';

const TimeoutMs = 120_000;
let pending = false;

interface GisTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}
interface GisWindow {
  google?: {
    accounts?: {
      oauth2?: {
        initTokenClient(cfg: {
          client_id: string;
          scope: string;
          prompt: string;
          callback: (r: GisTokenResponse) => void;
          error_callback?: (e: { message?: string; type?: string }) => void;
        }): { requestAccessToken(): void };
      };
    };
  };
}

function loadGis(): Promise<void> {
  const w = window as unknown as GisWindow;
  if (w.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.getElementById('poker-google-gsi') as HTMLScriptElement | null;
    const script = existing ?? document.createElement('script');
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener('error', () => reject(new Error('Could not load Google Identity Services.')), { once: true });
    if (!existing) {
      script.id = 'poker-google-gsi';
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  });
}

/**
 * Opens the Google account picker. Resolves `{ ok: true, value: 'token:…' }` or `{ ok: false, value: <message> }`.
 */
export async function requestGoogleCredential(): Promise<{ ok: boolean; value: string }> {
  const clientId = PlayFabConfig.GoogleWebClientId as string;
  if (!clientId.trim() || clientId.startsWith('REPLACE_')) {
    return { ok: false, value: 'Google Client ID is not set. Add your Web OAuth client id to PlayFabConfig.GoogleWebClientId and enable the Google add-on in PlayFab Game Manager.' };
  }
  if (!playFab()?.isLive) return { ok: false, value: 'Google sign-in needs the live PlayFab title (online mode). Guest still works here.' };
  if (pending) return { ok: false, value: 'Google sign-in is already in progress.' };

  pending = true;
  try {
    await loadGis();
    const oauth2 = (window as unknown as GisWindow).google?.accounts?.oauth2;
    if (!oauth2) return { ok: false, value: 'Google sign-in script failed to load.' };
    const payload = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('error:Google sign-in timed out. Close the popup and try again.'), TimeoutMs);
      const done = (p: string) => {
        clearTimeout(timer);
        resolve(p);
      };
      const client = oauth2.initTokenClient({
        client_id: clientId.trim(),
        scope: 'openid email profile',
        prompt: 'select_account',
        callback: (r) => {
          if (!r) done('error:Google returned an empty response.');
          else if (r.error) done('error:' + (r.error_description || r.error));
          else if (!r.access_token) done('error:Google did not return an access token.');
          else done('token:' + r.access_token);
        },
        error_callback: (e) => done('error:' + (e?.message || e?.type || 'popup_closed')),
      });
      client.requestAccessToken();
    });
    if (!payload) return { ok: false, value: 'Google returned an empty response.' };
    if (payload.startsWith('token:') || payload.startsWith('code:')) return { ok: true, value: payload };
    if (payload.startsWith('error:')) return { ok: false, value: payload.substring('error:'.length) };
    return { ok: false, value: payload };
  } catch (e) {
    return { ok: false, value: e instanceof Error ? e.message : String(e) };
  } finally {
    pending = false;
  }
}
