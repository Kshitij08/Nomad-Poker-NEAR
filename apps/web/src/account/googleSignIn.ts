/**
 * Sign in with Google in the browser (Google Identity Services). Yields the Google ID token the API checks
 * (apps/api/src/google.ts); the API then signs the player in, or links Google to the guest already signed in.
 *
 * Flow: a small dialog shows Google's own "Sign in with Google" button, which opens Google's account chooser and
 * hands back the ID token. The CSP allows accounts.google.com for this
 * (scripts/securityHeaders.mjs).
 */

/** The web OAuth client (Google Cloud project "Nomad Poker"); a public value. VITE_GOOGLE_CLIENT_ID overrides it. */
export const GOOGLE_WEB_CLIENT_ID = '114523122703-ps6fj6q10ofb9pkft4g1dd4rrnv9k01r.apps.googleusercontent.com';

const GSI_SRC = 'https://accounts.google.com/gsi/client';

interface CredentialResponse {
  credential?: string;
}
interface GoogleId {
  initialize(o: Record<string, unknown>): void;
  renderButton(el: HTMLElement, o: Record<string, unknown>): void;
  cancel(): void;
}
declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleId } };
  }
}

export function googleClientId(): string {
  const v = (import.meta.env as Record<string, unknown>).VITE_GOOGLE_CLIENT_ID;
  return typeof v === 'string' && v ? v : GOOGLE_WEB_CLIENT_ID;
}

let loading: Promise<GoogleId> | null = null;

function loadGsi(): Promise<GoogleId> {
  const ready = window.google?.accounts?.id;
  if (ready) return Promise.resolve(ready);
  loading ??= new Promise<GoogleId>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GSI_SRC;
    s.async = true;
    s.onload = () => {
      const id = window.google?.accounts?.id;
      if (id) resolve(id);
      else reject(new Error('Google sign-in did not load.'));
    };
    s.onerror = () => {
      loading = null;
      reject(new Error("Couldn't reach Google. Check your connection and try again."));
    };
    document.head.append(s);
  });
  return loading;
}

/** The fallback dialog: Google's own button (it opens Google's popup) and a Cancel. */
function buttonDialog(id: GoogleId, onCancel: () => void): () => void {
  const back = document.createElement('div');
  back.className = 'v2-gsi-back';
  Object.assign(back.style, {
    position: 'fixed', inset: '0', zIndex: '10000', display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(10, 6, 30, 0.6)', padding: '16px',
  } satisfies Partial<CSSStyleDeclaration>);
  const card = document.createElement('div');
  Object.assign(card.style, {
    background: '#2a1866', border: '2px solid rgba(255,255,255,0.18)', borderRadius: '18px', padding: '22px 22px 16px',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px', color: '#fff', maxWidth: '340px', width: '100%',
    fontFamily: "var(--v2-ui, system-ui, -apple-system, 'Segoe UI', sans-serif)", textAlign: 'center',
  } satisfies Partial<CSSStyleDeclaration>);
  const title = document.createElement('div');
  title.textContent = 'Continue with Google';
  Object.assign(title.style, { fontWeight: '800', fontSize: '18px' });
  const slot = document.createElement('div');
  slot.style.minHeight = '44px';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  Object.assign(cancel.style, { background: 'transparent', color: '#cfc6ff', border: '0', fontFamily: 'inherit', fontSize: '15px', fontWeight: '700', cursor: 'pointer', padding: '6px 12px' });
  card.append(title, slot, cancel);
  back.append(card);
  document.body.append(back);
  id.renderButton(slot, { type: 'standard', theme: 'filled_blue', size: 'large', shape: 'pill', text: 'continue_with', logo_alignment: 'left', width: 280 });
  const close = () => back.remove();
  cancel.addEventListener('click', () => {
    close();
    onCancel();
  });
  back.addEventListener('click', (e) => {
    if (e.target === back) {
      close();
      onCancel();
    }
  });
  return close;
}

/** Asks Google for an ID token. Resolves null when the player cancels; rejects when Google can't be reached. */
export async function requestGoogleIdToken(): Promise<string | null> {
  const id = await loadGsi();
  return new Promise<string | null>((resolve) => {
    let settled = false;
    let closeDialog: (() => void) | null = null;
    const done = (token: string | null) => {
      if (settled) return;
      settled = true;
      closeDialog?.();
      try {
        id.cancel();
      } catch {
        /* nothing showing */
      }
      resolve(token);
    };
    id.initialize({
      client_id: googleClientId(),
      callback: (r: CredentialResponse) => done(r.credential ?? null),
      auto_select: false,
      cancel_on_tap_outside: true,
      context: 'signin',
    });
    // Google's own button in a small dialog: its click opens Google's account chooser. (The One Tap prompt is not
    // used: under FedCM it reports nothing when it can't show, so a player without a Google session would be stuck.)
    closeDialog = buttonDialog(id, () => done(null));
  });
}
