/**
 * Menu actions the Redesign v2 screens (src/ui2) share: the daily spin, and sitting at a Coins table (the net module's
 * Quick Play / FreePlayJoin with the Connecting cover, else the offline single-player table at that stake).
 */
import { TEST_SCENE_TABLE_SETTINGS, type StakeTier } from '@nomad/engine';
import type { TableScreenParams } from '../table/tableScreen';
import type { NomadHost } from './host';
import { svc } from './deps';
import { PokerFunnel } from './funnel';

/** The daily spin: host.actions.openDailySpin (ui2's Daily spin page), else the spin screen by name. */
export function openDailySpin(host: NomadHost): void {
  if (host.actions.openDailySpin) return host.actions.openDailySpin();
  if (!host.signedIn) return host.show('Login');
  host.show('LuckySlot_Win');
}

/**
 * Sits at a Coins table: the net module's Quick Play / FreePlayJoin when it is installed (with the Connecting cover,
 * Disconnect cancels, a minute with no table says so), else the offline single-player table at this stake.
 */
export async function joinFreePlay(host: NomadHost, tier: StakeTier, buyIn: number, how: 'quick' | 'join'): Promise<void> {
  const net = svc(host.ctx, 'net');
  const go = how === 'quick' ? net?.quickPlay : net?.freePlayJoin;
  if (go) {
    host.showConnecting(() => net?.cancelSearch?.());
    const timeout = window.setTimeout(() => {
      host.closeConnecting();
      net?.cancelSearch?.();
      if (host.isShowing('MainMenu')) host.message('Quick Play', `No table at ${tier.displayName} stakes answered. Try again, or pick another stake in Tables.`);
    }, 60_000);
    try {
      await go.call(net, { tier, buyIn });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Web addition: only when NO table server answered (NetConnectError.unreachable), offer the offline table at
      // the same stake. Any other join error is shown the way Unity shows it.
      if ((e as { unreachable?: boolean }).unreachable)
        host.message('Quick Play', message + '\n\nPlay against bots offline at this stake instead?', 'Play offline', () => void offlineTable(host, tier, buyIn), 'Cancel');
      else host.message('Quick Play', message);
    } finally {
      window.clearTimeout(timeout);
      host.closeConnecting();
    }
    return;
  }
  await offlineTable(host, tier, buyIn);
}

/** Offline Free Play (PokerGameController): this stake's blinds, the buy-in as the stack. */
export async function offlineTable(host: NomadHost, tier: StakeTier, buyIn: number): Promise<void> {
  PokerFunnel.beginTable(`offline-${tier.minBuyIn}`, tier.minBuyIn, buyIn, false);
  const params: TableScreenParams = {
    settings: {
      ...TEST_SCENE_TABLE_SETTINGS,
      smallBlind: tier.smallBlind,
      bigBlind: tier.bigBlind,
      startingStack: buyIn,
      playerName: host.ctx.services.account.displayName,
    },
    onLeave: () => PokerFunnel.endTable(),
  };
  await host.ctx.router.navigate('table', params);
}
