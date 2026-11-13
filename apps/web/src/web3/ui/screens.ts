/**
 * The web3 module's router screens and table hooks. Screen ids:
 *  - 'wallet-login'   Auth/WalletLoginUI.cs runtime panel (SIWS sign-in + email capture)          [walletLogin.ts]
 *  - 'wallet-picker'  the SDK's WalletAdapterUI picker (WalletAdapterPopup.cs)                     [walletPicker.ts]
 *  - 'private-buy-in' Net/PrivateBuyInPrompt.cs                                                    [buyInPrompt.ts]
 *
 * The private SOL tables, tournaments and Agent are Redesign v2 pages (src/ui2/screens: play.ts, solTourneys.ts,
 * solAgent.ts) built on the actions in lobby.ts, lobbyHost.ts, lobbyTourney.ts and lobbyAgent.ts.
 */
import type { AppContext } from '../../app/app';
import { tableLeaveHooks } from '../../menu/table/nomadTableHud';
import { WalletLoginScreen } from './walletLogin';
import { WalletPickerScreen, type WalletPickerParams } from './walletPicker';
import { PrivateBuyInScreen } from './buyInPrompt';
import { w3 } from '../services';

export function installWeb3Screens(ctx: AppContext): void {
  ctx.router.register('wallet-login', (c) => new WalletLoginScreen(c));
  ctx.router.register('wallet-picker', (c) => new WalletPickerScreen(c));
  w3(ctx).solana.picker = (wallets) =>
    new Promise((resolve) => void ctx.router.push('wallet-picker', { wallets, resolve } satisfies WalletPickerParams));
  ctx.router.register('private-buy-in', (c) => new PrivateBuyInScreen(c));
  // The menu's leave dialog words a tournament table differently (PerTableController.IsTournament). The controller
  // module is lazy: until a private table has been opened there is nothing to ask.
  const prev = tableLeaveHooks.isTournament;
  tableLeaveHooks.isTournament = (host) => {
    const per = w3(ctx).per.loaded;
    return (per ? per.isTournamentTable(host) : false) || (prev?.(host) ?? false);
  };
}
