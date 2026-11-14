/**
 * Solana behind the chain seam (src/chain): the private-rollup tables, SOL Agent and SOL tournaments, as before. Every
 * call goes to the existing code in ui/lobby*.ts and per/; this file only converts addresses and wraps the runtime.
 */
import type { AppContext } from '../app/app';
import type { ChainMoney, ChainService, CopyTerms } from '../chain';
import { PerBuyIn, STAKES, sol, stakeMaxBuyIn, stakeMinBuyIn } from './per/money';
import { deployedText } from './nomad/solAgentCopy';
import type { SolCopy } from '../menu/screens/market';
import { w3 } from './services';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const solanaMoney: ChainMoney = {
  symbol: 'SOL',
  icon: 'sol',
  format: sol,
  stakes: STAKES,
  minBuyIn: stakeMinBuyIn,
  maxBuyIn: stakeMaxBuyIn,
  buyIn: PerBuyIn,
};

/** Loads @solana/web3.js, the private-tables runtime and the lobby modules (the first On-chain action). */
export async function loadSolanaChain(ctx: AppContext): Promise<ChainService> {
  const [per, lobby, agents, tourneys, hosting, { PublicKey }] = await Promise.all([
    w3(ctx).per.get(),
    import('./ui/lobby'),
    import('./ui/lobbyAgent'),
    import('./ui/lobbyTourney'),
    import('./ui/lobbyHost'),
    import('@solana/web3.js'),
  ]);
  const key = (address: string) => new PublicKey(address);
  // The marketplace's SOL copy carries the creator and fee terms the program needs; the seam only names it.
  const asSolCopy = (c: CopyTerms | null) => c as SolCopy | null;

  return {
    id: 'solana',
    money: solanaMoney,
    connectWallet: () => w3(ctx).solana.connect(),
    lobby: {
      read: () => lobby.readLobby(per),
      join: (table, buyIn, st, expect) => lobby.joinAndGo(ctx, per, table, buyIn, st, expect ?? undefined),
      host: (o, st) => hosting.hostSolTable(ctx, per, { stake: o.stake, seats: o.seats, inviteOnly: o.inviteOnly, invitees: o.invitees.map(key) }, st),
      open: (row, st) => lobby.openHosted(per, key(row.address), st),
      close: (row, st) => lobby.closeHosted(per, key(row.address), st),
      reclaim: (row, st) => lobby.reclaimHosted(per, key(row.address), row.id, st),
      newInviteLink: (row, st) => lobby.newInviteLink(per, key(row.address), st),
      closeOldInvites: (id, st) => lobby.closeOldInvites(per, id, st),
      isAccount: (text) => BASE58.test(text),
      revokeSessions: (st) => per.gameWallet.revokePlayKeys(st),
    },
    agent: {
      options: { STAKES: agents.STAKES, BUY_IN_BB: agents.BUY_IN_BB, HANDS: agents.HANDS, MINUTES: agents.MINUTES, LOSS_PCT: agents.LOSS_PCT, PROFIT_PCT: agents.PROFIT_PCT },
      label: agents.agentLabel,
      read: () => agents.readSolAgent(per),
      deploy: (limits, profile, copy, st) => agents.deploySolAgent(ctx, per, limits, profile, asSolCopy(copy), st),
      stop: (st) => agents.stopSolAgent(ctx, per, st),
      deployedText: (stakeText, copy) => deployedText(stakeText, asSolCopy(copy)),
    },
    tourneys: {
      choices: {
        PLAYERS: tourneys.PLAYERS,
        FEES: tourneys.FEES,
        PRIZES: tourneys.PRIZES,
        START_MINUTES: tourneys.START_MINUTES,
        SPEED_LABELS: [...per.tourney.SPEED_LABELS],
        TURBO: per.tourney.TURBO,
      },
      read: () => tourneys.readTourneys(ctx, per),
      register: (address, code, st) => tourneys.registerTourney(ctx, per, address, code, st),
      leaveOrCancel: (address, cancel, st) => tourneys.leaveOrCancelTourney(per, address, cancel, st),
      findByCode: (code) => tourneys.findTourneyByCode(per, code),
      goToTable: (address, table, st) => tourneys.goToTourneyTable(ctx, per, address, table, st),
      create: (o, st) => tourneys.createSolTourney(ctx, per, o, st),
    },
  };
}
