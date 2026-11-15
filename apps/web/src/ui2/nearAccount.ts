/**
 * On-chain without a wallet: the "Play on NEAR" chooser (a NEAR account made for you, the one this browser keeps, a
 * backup, or your own wallet) and the key backup dialog. The account and its relayer are near/localKey.ts.
 */
import { btn, esc } from './core';
import { accountExtras, app, friendlyError, S, ui } from './ctx';
import { formatNear } from '../near/backing';
import type { LocalKey, SessionLike } from '../near/localKey';

const localKeys = () => import('../near/localKey');

/** The Nomad session, when this build has a Nomad server. */
const session = (): (SessionLike & { me: unknown }) | null => S('nomadApi') ?? null;

/**
 * Asks how to play on NEAR and signs in that way. Resolves true once you're signed in with a NEAR account. `wallet` is
 * the wallet path (NEAR Connect sign-in), which the caller already has.
 */
export async function chooseNear(wallet: () => Promise<boolean>): Promise<boolean> {
  const s = session();
  if (!s) return wallet();
  const { loadLocalKey } = await localKeys();
  const kept = loadLocalKey();
  return new Promise<boolean>((resolve) => {
    const done = (v: boolean) => resolve(v);
    const close = () => ui().closeDialog();
    const keptLine = kept?.accountId ? `<p>This browser keeps your NEAR account <b>${esc(kept.accountId)}</b>.</p>` : '';
    ui().openDialog({
      title: 'Play on NEAR',
      dismiss: false,
      body: `<p>On-chain plays for NEAR on testnet. We can make you a NEAR account in one tap: it's free, the game pays every move's network fee, and its key stays in this browser (you can back it up).</p>${keptLine}<p class="v2-xs">Have a NEAR wallet? Connect it instead.</p>`,
      buttons: `<div class="v2-btn-grid">${
        kept?.accountId ? btn(`Continue as ${esc(short(kept.accountId))}`, 'nc-kept', { h: 'gold' }) : btn('Create my NEAR account', 'nc-create', { h: 'gold' })
      }${btn('Connect a wallet', 'nc-wallet', { h: 'blue' })}${btn('Restore a backup', 'nc-restore', { h: 'ghost' })}${btn('Not now', 'nc-cancel', { h: 'ghost' })}</div>`,
      actions: {
        'nc-create': () => {
          close();
          void create().then(done);
        },
        'nc-kept': () => {
          close();
          void useKept(kept!).then(done);
        },
        'nc-wallet': () => {
          close();
          void wallet().then(done);
        },
        'nc-restore': () => {
          close();
          restore(done);
        },
        'nc-cancel': () => {
          close();
          done(false);
        },
      },
    });
  });
}

const short = (account: string): string => (account.length > 22 ? `${account.slice(0, 10)}…` : account);

/** A guest account first when nobody is signed in (the NEAR account links to it). */
async function ensureSignedIn(): Promise<boolean> {
  const s = session();
  if (!s) return false;
  if (s.signedIn) return true;
  await accountExtras(app()).signInAsGuest?.();
  return session()?.signedIn ?? false;
}

async function busy<T>(text: string, fn: () => Promise<T>): Promise<T> {
  ui().openDialog({ title: 'Play on NEAR', dismiss: false, body: `<p>${esc(text)}</p>`, buttons: '' });
  try {
    return await fn();
  } finally {
    ui().closeDialog();
  }
}

async function create(): Promise<boolean> {
  try {
    if (!(await ensureSignedIn())) throw new Error('Sign in first (a guest is fine).');
    const { createNearAccount } = await localKeys();
    const k = await busy('Making your NEAR account… (a few seconds)', () => createNearAccount(session()!));
    signedInChanged();
    ready(k);
    return true;
  } catch (e) {
    ui().message('Create my NEAR account', esc(friendlyError(e, "Couldn't make your NEAR account. Try again, or connect a wallet.")));
    return false;
  }
}

async function useKept(k: LocalKey): Promise<boolean> {
  try {
    if (!(await ensureSignedIn())) throw new Error('Sign in first (a guest is fine).');
    const { signInWithLocalKey } = await localKeys();
    await busy(`Signing in as ${k.accountId}…`, () => signInWithLocalKey(session()!, k));
    signedInChanged();
    return true;
  } catch (e) {
    ui().message('Continue with NEAR', esc(friendlyError(e, "Couldn't sign in with this browser's NEAR account. Try again.")));
    return false;
  }
}

function restore(done: (ok: boolean) => void): void {
  ui().openDialog({
    title: 'Restore a backup',
    dismiss: false,
    body: `<p>Paste the NEAR key backup you saved (the whole file, starting with {).</p><textarea class="v2-field" id="v2-near-restore" data-dlg-in="1" rows="6" style="width:100%;font-family:monospace;font-size:.8em" autocomplete="off" spellcheck="false"></textarea>`,
    buttons: btn('Cancel', 'nr-cancel', { h: 'ghost' }) + btn('Restore', 'nr-ok', { h: 'gold' }),
    actions: {
      'nr-cancel': () => {
        ui().closeDialog();
        done(false);
      },
      'nr-ok': () => {
        const text = (document.getElementById('v2-near-restore') as HTMLTextAreaElement | null)?.value ?? '';
        ui().closeDialog();
        void (async () => {
          try {
            const { restoreBackup } = await localKeys();
            done(await useKept(restoreBackup(text)));
          } catch (e) {
            ui().message('Restore a backup', esc(friendlyError(e, "That backup didn't work.")));
            done(false);
          }
        })();
      },
    },
  });
}

function signedInChanged(): void {
  app().events.emit('account:changed');
  ui().render();
}

function ready(k: LocalKey): void {
  ui().openDialog({
    title: 'Your NEAR account is ready',
    body: `<p><b>${esc(k.accountId ?? '')}</b></p><p>It starts with ${formatNear(10n ** 23n)} NEAR (testnet) to deposit and buy in with, and the game pays every move's network fee. Its key lives in this browser: back it up to keep the account if you clear this browser or switch devices.</p>`,
    buttons: btn('Back up key', 'nk-backup', { h: 'ghost' }) + btn('Play', 'nk-ok', { h: 'gold' }),
    actions: {
      'nk-backup': () => void nearBackup(),
      'nk-ok': () => ui().closeDialog(),
    },
  });
}

/** Whether you play as the account this browser keeps (its moves go through the relayer, no wallet). */
export async function playingLocal(account: string | null): Promise<boolean> {
  if (!account) return false;
  return (await localKeys()).loadLocalKey()?.accountId === account;
}

/** Shows the key backup: copy it or save it as a file (near-cli's format; wallets import it too). */
export async function nearBackup(): Promise<void> {
  const { loadLocalKey, backupJson } = await localKeys();
  const k = loadLocalKey();
  if (!k?.accountId) return ui().message('Back up key', 'This browser has no NEAR account made for you.');
  const json = backupJson(k);
  ui().openDialog({
    title: 'Back up your NEAR key',
    body: `<p>Anyone with this key controls <b>${esc(k.accountId)}</b> and its NEAR. Keep it somewhere private; paste it into "Restore a backup" on another device, or import it into a NEAR wallet.</p><textarea class="v2-field" readonly rows="6" style="width:100%;font-family:monospace;font-size:.75em" spellcheck="false">${esc(json)}</textarea>`,
    buttons: btn('Copy', 'nb-copy', { h: 'ghost' }) + btn('Save file', 'nb-save', { h: 'ghost' }) + btn('Done', 'nb-ok', { h: 'gold' }),
    actions: {
      'nb-copy': () => {
        void navigator.clipboard?.writeText(json).then(() => ui().toast('Key copied'), () => ui().toast("Couldn't copy; select the text instead"));
      },
      'nb-save': () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        a.download = `${k.accountId}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      },
      'nb-ok': () => ui().closeDialog(),
    },
  });
}
