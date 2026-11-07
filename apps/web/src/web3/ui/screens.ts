/**
 * The web3 module's router screens and table hooks. Screen ids:
 *  - 'wallet-login'   Auth/WalletLoginUI.cs runtime panel (SIWS sign-in + email capture)          [walletLogin.ts]
 *  - 'wallet-picker'  the SDK's WalletAdapterUI picker (WalletAdapterPopup.cs)                     [walletPicker.ts]
 *  - 'private-tables' Per/Unity/PerLobbyPanel.cs (+ host / tournaments / agent tabs)               [lobby*.ts]
 *  - 'cash-out'       Net/CashOutPanel.cs (CashOut_Panel prefab)                                   [cashOut.ts]
 *  - 'private-buy-in' Net/PrivateBuyInPrompt.cs                                                    [buyInPrompt.ts]
 */
import type { AppContext } from '../../app/app';
import { tableLeaveHooks } from '../../menu/table/nomadTableHud';
import { WalletLoginScreen } from './walletLogin';
import { WalletPickerScreen, type WalletPickerParams } from './walletPicker';
import { CashOutScreen } from './cashOut';
import { PrivateBuyInScreen } from './buyInPrompt';
import { LazyPanelScreen } from './lazy';
import { w3 } from '../services';

export function installWeb3Screens(ctx: AppContext): void {
  ctx.router.register('wallet-login', (c) => new WalletLoginScreen(c));
  ctx.router.register('wallet-picker', (c) => new WalletPickerScreen(c));
  w3(ctx).solana.picker = (wallets) =>
    new Promise((resolve) => void ctx.router.push('wallet-picker', { wallets, resolve } satisfies WalletPickerParams));
  ctx.router.register('cash-out', (c) => new CashOutScreen(c));
  ctx.router.register('private-buy-in', (c) => new PrivateBuyInScreen(c));
  // The private-table panels need @solana/web3.js: their code loads on first open (with w3(ctx).per).
  ctx.router.register('private-tables', (c) => new LazyPanelScreen(c, async () => (await import('./lobby')).lobbyPanel));
  ctx.router.register('private-host', (c) => new LazyPanelScreen(c, async () => (await import('./lobbyHost')).hostPanel));
  ctx.router.register('private-tourneys', (c) => new LazyPanelScreen(c, async () => (await import('./lobbyTourney')).tourneyPanel));
  ctx.router.register('private-tourney-host', (c) => new LazyPanelScreen(c, async () => (await import('./lobbyTourney')).tourneyHostPanel));
  ctx.router.register('private-agent', (c) => new LazyPanelScreen(c, async () => (await import('./lobbyAgent')).agentPanel));
  // The menu's leave dialog words a tournament table differently (PerTableController.IsTournament). The controller
  // module is lazy: until a private table has been opened there is nothing to ask.
  const prev = tableLeaveHooks.isTournament;
  tableLeaveHooks.isTournament = (host) => {
    const per = w3(ctx).per.loaded;
    return (per ? per.isTournamentTable(host) : false) || (prev?.(host) ?? false);
  };
}
