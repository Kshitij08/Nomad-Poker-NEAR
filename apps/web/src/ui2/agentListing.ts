/**
 * Agents › Overview in On-chain: list your Agent on the NEAR table contract so others can stake on it (Back a pro),
 * or update the strategy of one you listed. The profile is the Strategy tab's settings, as the contract's v2 profile.
 * In Demo, Overview still sends the Agent to a Coins table.
 */
import { STRATEGY_NAMES, type AgentStrategyState } from '@nomad/engine/agents';
import { getAgent, listAgents, registerAgent, updateAgent, validAgentId, type Agent, type AgentProfile, type ProfileNumbers } from '../near/backing';
import { connectNear, friendlyError, nearAccountId, prompt, ui } from './ctx';
import { btn, esc } from './core';
import {
  MAX_STRATEGY_BYTES, NEAR_AI_MODEL, clearPrivateStrategy, getNearAiSigners, getStrategyKey, sealStrategy, setPrivateStrategy, strategyBytes,
} from '../near/nearAi';

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

// ------------------------------------------------------------------ NEAR AI: a private strategy

/** "NEAR AI" with the model's short name, e.g. "NEAR AI · Qwen3.6". */
export const nearAiLabel = (model: string): string => `NEAR AI · ${esc(model.split('/').pop()!.split('-')[0] || model)}`;

/**
 * Write a private strategy for an agent you listed: plain-words instructions, sealed in this browser to the dealer's
 * key so only the sealed dealer can read them. Each session a private model on NEAR AI turns them into the settings
 * it plays; the contract checks the model's signature before paying out. Or stop using one.
 */
export async function privateStrategyDialog(agentId: string): Promise<void> {
  const a = myListings.list.find((x) => x.id === agentId);
  if (!a) return;
  const current = a.private_strategy;
  const [key, signers] = await Promise.all([getStrategyKey().catch(() => null), getNearAiSigners().catch(() => [])]);
  const model = NEAR_AI_MODEL;
  if (!key || !signers.some((s) => s.model === model && s.signing_addresses.length))
    return ui().message('Private strategy', 'NEAR AI agents are not set up on this table right now. Try again later.');
  const save = (text: string) => {
    let sealed: { eph: string; ct: string };
    try {
      sealed = sealStrategy(text, key, agentId);
    } catch (e) {
      return ui().message('Private strategy', esc((e as Error).message));
    }
    ui().closeDialog();
    void sendPrivate('Confirm the private strategy in your wallet…', `${agentId} now plays a private strategy. Each session, NEAR AI picks its settings from your text.`, () => setPrivateStrategy(agentId, sealed, model));
  };
  const count = () => {
    const el = document.getElementById('v2-pstrat') as HTMLTextAreaElement | null;
    const out = document.getElementById('v2-pstrat-n');
    if (el && out) out.textContent = `${strategyBytes(el.value)} / ${MAX_STRATEGY_BYTES}`;
  };
  ui().openDialog({
    title: `Private strategy: ${esc(agentId)}`,
    body: `<div class="v2-col" style="gap:.5em"><div class="v2-sm">Tell your agent how to play, in plain words. Your browser seals it so only the sealed dealer can read it: it never appears on NEAR, and backers see only that it's private. Each session a private model on NEAR AI (${esc(model.split('/').pop()!)}, in a secure enclave) turns it into that session's settings, and the contract checks the model's signature before paying out.</div>
<textarea class="v2-field" id="v2-pstrat" data-dlg-in="1" rows="6" maxlength="${MAX_STRATEGY_BYTES}" style="width:100%" placeholder="e.g. Play few hands early. With a strong hand, raise big. Bluff rarely, and only on the river." spellcheck="true"></textarea>
<div class="v2-row v2-xs v2-mut"><span class="v2-grow">${current ? `Your current private strategy (${current.sealed_bytes - 16} bytes) stays sealed; what you write here replaces it.` : 'If NEAR AI can\'t be reached in time, it plays your Strategy-tab settings.'} Saving starts a new strategy version.</span><span id="v2-pstrat-n">0 / ${MAX_STRATEGY_BYTES}</span></div></div>`,
    buttons: (current ? btn('Stop using it', 'ps-clear', { h: 'ghost' }) : '') + btn('Cancel', 'ps-cancel', { h: 'ghost' }) + btn('Seal &amp; save', 'ps-save', { h: 'gold' }),
    actions: {
      'ps-cancel': () => ui().closeDialog(),
      'ps-save': () => save(((document.getElementById('v2-pstrat') as HTMLTextAreaElement | null)?.value ?? '').trim()),
      'ps-clear': () => {
        ui().closeDialog();
        void sendPrivate('Confirm in your wallet…', `${agentId} plays your Strategy-tab settings again.`, () => clearPrivateStrategy(agentId));
      },
    },
  });
  queueMicrotask(() => document.getElementById('v2-pstrat')?.addEventListener('input', count));
}

async function sendPrivate(pending: string, done: string, fn: () => Promise<void>): Promise<void> {
  ui().toast(pending, 4000);
  try {
    await fn();
    ui().message('Private strategy', esc(done));
  } catch (e) {
    if (!/cancel|reject|closed|denied/i.test(String((e as Error)?.message ?? e)))
      ui().message('NEAR', esc(friendlyError(e, "The wallet couldn't send it. Try again.")));
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
