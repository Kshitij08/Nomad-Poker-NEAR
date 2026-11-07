/**
 * The copied marketplace SOL strategy in the SOL Agent's deployment: the parts of NomadUiHost.Onchain
 * OnchainDeployOrStop that read NomadUiHost.Market's CopiedSol, kept free of the network so they can be tested.
 *
 * Deploying with a copy: the settings carry its `strategyId` (the Agent service then plays the strategy's profile, not
 * the Strategy tab's), /agents/prepare answers with the fee terms, and the play key signs agent_set with exactly the
 * terms the player was shown, never a creator or share the service swapped in. The program then pays the creator's and
 * Nomad's shares of new profit at every cash-out. The player's own strategy runs with no terms.
 */
import { feePercent, solCopyIsOwn, type SolCopy } from '../../menu/screens/market';
import type { FeeTerms } from '../per/types';

/** The settings' copy field: `strategyId` when copying (C#: `if (copy != null) settings["strategyId"] = copy.Id`). */
export function withCopiedStrategy<T extends Record<string, unknown>>(settings: T, copy: SolCopy | null): T & { strategyId?: string } {
  if (copy) (settings as Record<string, unknown>).strategyId = copy.id;
  return settings;
}

/**
 * The fee terms the play key signs, from /agents/prepare's answer: none without a copy or for the player's own
 * strategy (the service must not ask for any), else the copy's own terms once the service's match them. Throws the
 * C#'s errors.
 */
export function copyTerms(
  copy: SolCopy | null,
  walletAddress: string | null,
  prepTerms: unknown,
  makeTerms: (creator: string, creatorFeeBps: number, platformFeeBps: number) => FeeTerms,
): FeeTerms | null {
  if (!copy) return null;
  const isObject = prepTerms !== null && typeof prepTerms === 'object' && !Array.isArray(prepTerms);
  if (solCopyIsOwn(copy, walletAddress)) {
    // Your own strategy: no fee, so no terms.
    if (isObject) throw new Error('the Agent service asked for fees on your own strategy');
    return null;
  }
  const t = prepTerms as Record<string, unknown>;
  if (!isObject || String(t.creator ?? '') !== copy.creator || Number(t.creatorFeeBps) !== copy.creatorFeeBps || Number(t.platformFeeBps) !== copy.platformFeeBps)
    throw new Error('the strategy\'s fees changed since you chose it: open the Marketplace and copy it again');
  return makeTerms(copy.creator, copy.creatorFeeBps, copy.platformFeeBps);
}

/** The busy note while the play key sets the Agent on chain. */
export function deployBusyText(copy: SolCopy | null): string {
  return copy == null ? 'Setting your Agent on chain (your play key signs; no wallet prompt)…'
    : `Setting your Agent on chain with "${copy.name}"'s fees (${feePercent(copy.creatorFeeBps)}% + ${feePercent(copy.platformFeeBps)}% of new profit; your play key signs)…`;
}

/** "Agent deployed": `stakeText` is PerUi.Sol(stake). */
export function deployedText(stakeText: string, copy: SolCopy | null): string {
  return `It plays SOL tables with up to ${stakeText} at risk. If no table has players, it opens one.` +
    (copy == null ? '' : ` It plays "${copy.name}"; the creator and Nomad get their share of new profit at each cash-out.`);
}
