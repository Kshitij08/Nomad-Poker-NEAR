/**
 * Party Create / Join by code and Watch a table, for the Redesign v2 Play and Agents pages (src/ui2): the net module's
 * private tables behind the menu host's Connecting cover, errors in its message box.
 */
import type { AppContext } from '../app/app';
import { formatN0 } from '@nomad/engine/util/dotnetMath';
import type { NomadHost } from '../menu/host';
import { VirtualEconomy } from './virtualEconomy';

/** ChainTableMode.PrivateMinBuyIn / PrivateMaxBuyIn (Coins private tables). */
const PrivateMinBuyIn = 500;
const PrivateMaxBuyIn = 1000;

interface NetParty {
  createParty?(): Promise<void>;
  joinParty?(code: string): Promise<void>;
  watch?(code: string): Promise<void>;
  cancelSearch?(): void;
}

const signedIn = (ctx: AppContext): boolean => ctx.services.account.signedIn;
const net = (ctx: AppContext): NetParty | undefined => (ctx.services as unknown as { net?: NetParty }).net;

async function connect(host: NomadHost, go: () => Promise<void>, n: NetParty): Promise<void> {
  host.showConnecting(() => n.cancelSearch?.());
  try {
    await go();
  } catch (e) {
    host.message('Party', e instanceof Error ? e.message : String(e));
  } finally {
    host.closeConnecting();
  }
}

/** Party Create / Join. */
export function startParty(host: NomadHost, ctx: AppContext, create: boolean, rawCode: string): void {
  if (!signedIn(ctx)) {
    host.show('Login');
    return;
  }
  const n = net(ctx);
  if (!n?.createParty || !n.joinParty) {
    host.message('Party', 'Open the game from the menu scene to play.');
    return;
  }
  const code = rawCode.replace(/​/g, '').trim();
  if (!create && code.length === 0) {
    host.message('Join a party', 'Enter the session code your friend shared.');
    return;
  }
  if (!VirtualEconomy.wallet.canAfford(PrivateMinBuyIn)) {
    host.message('Not enough Coins', `Private tables buy in for ${formatN0(PrivateMinBuyIn)}–${formatN0(PrivateMaxBuyIn)} Coins. You have ${formatN0(VirtualEconomy.wallet.coins)}.`);
    return;
  }
  void connect(host, () => (create ? n.createParty!() : n.joinParty!(code.toUpperCase())), n);
}

/** Spectate a table: a public table's session name, or a private table's room code. No Coins needed. */
export function startWatch(host: NomadHost, ctx: AppContext, rawCode: string): void {
  const n = net(ctx);
  if (!n?.watch) {
    host.message('Watch a table', 'Open the game from the menu scene to watch.');
    return;
  }
  const code = rawCode.replace(/\u200b/g, '').trim();
  if (!code) {
    host.message('Watch a table', 'Enter the room code of the table you want to watch.');
    return;
  }
  void connect(host, () => n.watch!(code), n);
}
