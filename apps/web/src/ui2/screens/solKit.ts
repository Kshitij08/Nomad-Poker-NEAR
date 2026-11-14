/**
 * Shared bits of the On-chain pages: the private tables (play.ts), tournaments (solTourneys.ts) and the Agent
 * (solAgent.ts). Chain actions go through the chain seam (src/chain), loaded on first use; these pages run them through
 * `solTask`: a v2 dialog with a spinner and the action's progress, then a plain-language result or error. Resolves
 * true when the action finished without an error.
 */
import { chainMoney } from '../../chain';
import { btn, esc } from '../core';
import { ico } from '../icons';
import { ui, friendlyError } from '../ctx';

/** An on-chain amount: the currency icon and the amount. */
export const solAmt = (units: bigint | number, size = 1.05): string => {
  const m = chainMoney();
  return `<span class="v2-solamt">${ico(m.icon, size)}<b class="v2-num">${esc(m.format(units))}</b></span>`;
};

/** "AbCd…WxYz". */
export const shortAddr = (a: string): string => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

/** What a player reads when a SOL action fails. */
export function solError(e: unknown, fallback: string): string {
  const m = e instanceof Error ? e.message : String(e ?? '');
  if (/Timeout or cancelled|declined|rejected|User rejected|cancel/i.test(m))
    return "Your wallet didn't approve it, so nothing changed. If your wallet said “Network mismatch”, switch it to the test network (Devnet in the wallet's settings) and try again.";
  if (/enough devnet SOL|InvalidAccountForFee|insufficient lamports|insufficient funds|no record of a prior credit/i.test(m))
    return "Your wallet doesn't have enough test SOL for this (the amount plus a small network fee). Add some to your wallet and try again.";
  if (/\?perbackend|web3deployed|isn't configured|not configured|NetworkPolicy|refused: /i.test(m)) {
    console.warn('[ui2] SOL:', m);
    return 'SOL tables are unavailable right now. Try again later.';
  }
  // Chain and program errors ("sendTransaction failed: error 2012", "custom program error: 0x7dc") read as the fallback.
  if (/sendTransaction|simulation failed|custom program error|\berror \d{3,5}\b|instruction \d+/i.test(m)) {
    console.warn('[ui2] SOL:', m);
    return fallback;
  }
  return friendlyError(e, fallback);
}

let busy = false;
/** True while a SOL action runs (one at a time, like the panels' busy flag). */
export const solBusy = (): boolean => busy;

/**
 * Runs a SOL action with a progress dialog (spinner, the action's status lines, a ghost Hide). When it finishes the
 * dialog closes; a returned string is shown as the result, an error as `fallback` (or the error's own plain text).
 */
export async function solTask(title: string, fallback: string, op: (st: (s: string) => void) => Promise<string | void | null>, after?: () => void): Promise<boolean> {
  if (busy) {
    ui().toast('One moment: another action is still running', 2200);
    return false;
  }
  busy = true;
  let status = 'Getting ready…';
  let shown = true;
  ui().openDialog({
    title: esc(title),
    body: () => `<div class="v2-row" style="gap:.9em"><i class="v2-spin" aria-hidden="true"></i><span aria-live="polite">${esc(status)}</span></div>`,
    buttons: btn('Hide', 'st-hide', { h: 'ghost' }),
    actions: { 'st-hide': () => ((shown = false), ui().closeDialog()) },
    dismiss: false,
  });
  try {
    const done = await op((s) => {
      status = s.replace(/<[^>]+>/g, '');
      console.log(`[ui2] ${title}: ${status}`);
      if (shown) ui().render(true);
    });
    if (shown) ui().closeDialog();
    if (done) ui().message(esc(title), esc(done));
    return true;
  } catch (e) {
    console.error(e);
    if (shown) ui().closeDialog();
    ui().message(esc(title), esc(solError(e, fallback)));
    return false;
  } finally {
    busy = false;
    after?.();
    ui().render();
  }
}
