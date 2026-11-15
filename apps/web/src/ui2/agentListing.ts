/**
 * Agents › Overview in On-chain: list your Agent on the NEAR table contract so others can stake on it (Back a pro),
 * or update the strategy of one you listed. The profile is the Strategy tab's settings, as the contract's v2 profile.
 * In Demo, Overview still sends the Agent to a Coins table.
 */
import { STRATEGY_NAMES, type AgentStrategyState } from '@nomad/engine/agents';
import { getAgent, listAgents, registerAgent, updateAgent, validAgentId, type Agent, type AgentProfile, type ProfileNumbers } from '../near/backing';
import { connectNear, friendlyError, nearAccountId, prompt, ui } from './ctx';
import { esc } from './core';

/** The contract's limits per number, in hundredths (poker-core `profile.rs` MIN / MAX). */
const MIN = [10, 45, 10, 0, 30];
const MAX = [55, 90, 95, 25, 120];

function numbers(v: readonly number[]): ProfileNumbers {
  const h = (i: number) => Math.min(MAX[i]!, Math.max(MIN[i]!, Math.round((v[i] ?? 0) * 100)));
  return { fold_below: h(0), raise_above: h(1), aggression: h(2), bluff_chance: h(3), raise_size: h(4) };
}

/** The Strategy tab's settings as the contract's v2 profile. */
export function profileOf(st: AgentStrategyState): AgentProfile {
  const streets = st.streets.some((s) => s != null) ? st.streets.slice(0, 4).map((s) => (s ? numbers(s) : null)) : [];
  return {
    ...numbers(st.values),
    position_weight: Math.min(100, Math.max(0, Math.round(st.positionWeight * 100))),
    streets,
    style: STRATEGY_NAMES[st.style] ?? 'Custom',
  };
}

/** An agent id the contract accepts, from the Agent's name: lowercase letters, digits and dashes. */
export function agentIdFrom(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'my-agent';
}

/** Agents you listed on NEAR (for Overview), loaded on demand. */
export const myListings = {
  account: null as string | null,
  list: [] as Agent[],
  loading: false,
  async load(): Promise<void> {
    const me = nearAccountId();
    this.account = me;
    if (!me) {
      this.list = [];
      return;
    }
    this.loading = true;
    try {
      this.list = (await listAgents()).map((c) => c.agent).filter((a) => a.owner === me);
    } catch {
      /* keep what we had */
    } finally {
      this.loading = false;
      ui().render();
    }
  },
};

async function send(pending: string, done: string, fn: () => Promise<void>): Promise<boolean> {
  ui().toast(pending, 4000);
  try {
    await fn();
    ui().message('Listed on NEAR', esc(done), 'Open Back a pro', () => ui().show('ag-back', 'pros'), 'Close');
    return true;
  } catch (e) {
    if (!/cancel|reject|closed|denied/i.test(String((e as Error)?.message ?? e)))
      ui().message('NEAR', esc(friendlyError(e, "The wallet couldn't send it. Try again.")));
    return false;
  } finally {
    void myListings.load();
  }
}

/** Review & List on NEAR: register the Agent under an id, or update the strategy of one you already listed. */
export async function listOnNear(st: AgentStrategyState): Promise<void> {
  let me = nearAccountId();
  if (!me && (await connectNear())) me = nearAccountId();
  if (!me) return;
  const profile = profileOf(st);
  const style = esc(profile.style ?? 'Custom');
  const suggested = myListings.list[0]?.id ?? agentIdFrom(st.agentName);
  prompt('List on NEAR',
    `Lists your Agent with its ${style} strategy from the Strategy tab. Others can then stake NEAR on it from Back a pro; it plays agent-vs-agent sessions dealt on NEAR, and you earn 8% of the profit it makes them. If you already listed this id, its strategy is updated instead. Use lowercase letters, digits and dashes.`,
    'my-agent', suggested, 'List on NEAR', (v) => {
      const id = v.trim().toLowerCase();
      if (!validAgentId(id)) return ui().message('List on NEAR', 'Use 1 to 32 lowercase letters, digits or dashes.');
      void (async () => {
        const existing = await getAgent(id).catch(() => null);
        if (existing && existing.owner !== me) return ui().message('List on NEAR', `<b>${esc(id)}</b> is taken by ${esc(existing.owner)}. Pick another id.`);
        if (existing) {
          if (JSON.stringify(existing.profile ?? null) === JSON.stringify(profile))
            return ui().message('List on NEAR', `<b>${esc(id)}</b> already plays this strategy. Change it on the Strategy tab to update it.`);
          await send('Confirm the strategy update in your wallet…', `${id} now plays your ${profile.style ?? 'Custom'} strategy. Backers see the new version.`, () => updateAgent(id, profile));
        } else {
          await send('Confirm the listing in your wallet…', `${id} is listed. Others can stake on it from Back a pro.`, () => registerAgent(id, profile));
        }
      })();
    }, 32);
}
