/**
 * The copied marketplace SOL strategy (NomadUiHost.Market CopiedSol → NomadUiHost.Onchain OnchainDeployOrStop).
 * Golden values: golden/market-golden.json, from golden/market-gen (the real generated bindings PokerPerIdl.cs + Borsh.cs
 * for agent_set, Newtonsoft for SolProfile, .NET's "0.#" for the fee shares). Instructions are built, never sent.
 */
import { Keypair, PublicKey } from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentStrategyState, type KeyValueStore } from '@nomad/engine/agents';
import type { NomadHost } from '../../menu/host';
import {
  applyProfileTo, feePercent, format0Hash, marketOnchain, marketState, onStrategyEdited, openMarket, openMyStrategies, solCopyIsOwn,
  solCopyMessage, solProfile, stopCopying, type SolCopy,
} from '../../menu/screens/market';
import type { PerHttp } from '../lib/http';
import { NO_PER_BACKEND, PerAgent } from '../per/agent';
import { PlayKey } from '../per/vault';
import { copyTerms, deployBusyText, deployedText, withCopiedStrategy } from '../nomad/solAgentCopy';
import golden from './golden/market-golden.json';

class MemStore implements KeyValueStore {
  readonly map = new Map<string, string>();
  getString(k: string, fb = ''): string {
    return this.map.get(k) ?? fb;
  }
  setString(k: string, v: string): void {
    this.map.set(k, v);
  }
}

const fill = (n: number) => new Uint8Array(32).fill(n);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const wallet = Keypair.fromSeed(fill(1)).publicKey;
const copyOf = (creator: string, c = 800, p = 200, name = 'Tight & Steady'): SolCopy => ({ id: '0b7d9c4e-1f2a-4c3b-9d8e-7f6a5b4c3d2e', name, creator, creatorFeeBps: c, platformFeeBps: p });

afterEach(() => {
  stopCopying();
  marketState.copiedValues = null;
  marketState.copiedStreets = null;
  for (const k of Object.keys(marketOnchain)) delete (marketOnchain as Record<string, unknown>)[k];
});

describe('copied SOL strategy: agent_set with its fee terms (C# PokerPerIdl.AgentSet)', () => {
  for (const g of golden.agentSet) {
    it(`terms ${g.creatorFill === null ? 'none' : `${g.creatorFeeBps}/${g.platformFeeBps}`}, agent ${g.agentFill}`, () => {
      const k = new PlayKey(Keypair.fromSeed(fill(2)), wallet, BigInt(g.expires), new Uint8Array(64).fill(3), 4);
      const creator = g.creatorFill === null ? null : new PublicKey(fill(g.creatorFill)).toBase58();
      // What /agents/prepare answers for this copy: the same terms the player was shown.
      const copy = creator ? copyOf(creator, g.creatorFeeBps, g.platformFeeBps) : null;
      const prep = creator ? { creator, creatorFeeBps: g.creatorFeeBps, platformFeeBps: g.platformFeeBps } : null;
      const terms = copyTerms(copy, wallet.toBase58(), prep, (c, cb, pb) => PerAgent.terms(new PublicKey(c), cb, pb));
      const ixs = g.agentFill === 0 ? PerAgent.stop(k) : PerAgent.set(k, new PublicKey(fill(g.agentFill)), BigInt(g.until), BigInt(g.stake), terms);
      expect(hex(ixs[1]!.data)).toBe(g.hex);
    });
  }
});

describe('copyTerms (OnchainDeployOrStop)', () => {
  const creator = new PublicKey(fill(8)).toBase58();
  const make = (c: string, cb: number, pb: number) => PerAgent.terms(new PublicKey(c), cb, pb);
  const shown = { creator, creatorFeeBps: 800, platformFeeBps: 200 };

  it('no copy: no terms (the C# does not check the answer then)', () => {
    expect(copyTerms(null, wallet.toBase58(), null, make)).toBeNull();
    expect(copyTerms(null, wallet.toBase58(), shown, make)).toBeNull();
  });

  it('your own strategy: no terms, and the service must not ask for any', () => {
    const own = copyOf(wallet.toBase58());
    expect(solCopyIsOwn(own, wallet.toBase58())).toBe(true);
    expect(solCopyIsOwn(own, null)).toBe(false);
    expect(copyTerms(own, wallet.toBase58(), null, make)).toBeNull();
    expect(() => copyTerms(own, wallet.toBase58(), { ...shown, creator: wallet.toBase58() }, make)).toThrow('the Agent service asked for fees on your own strategy');
  });

  it('a copy signs only the terms the player was shown', () => {
    const c = copyOf(creator);
    const t = copyTerms(c, wallet.toBase58(), shown, make)!;
    expect([hex(t.creator), t.creatorFeeBps, t.platformFeeBps]).toEqual([hex(fill(8)), 800, 200]);
    const changed = "the strategy's fees changed since you chose it: open the Marketplace and copy it again";
    expect(() => copyTerms(c, wallet.toBase58(), null, make)).toThrow(changed);
    expect(() => copyTerms(c, wallet.toBase58(), { ...shown, creator: new PublicKey(fill(9)).toBase58() }, make)).toThrow(changed);
    expect(() => copyTerms(c, wallet.toBase58(), { ...shown, creatorFeeBps: 900 }, make)).toThrow(changed);
    expect(() => copyTerms(c, wallet.toBase58(), { ...shown, platformFeeBps: 300 }, make)).toThrow(changed);
    // Not the player's own when no wallet is connected: the terms are still checked.
    expect(copyTerms(c, null, shown, make)).not.toBeNull();
  });

  it('settings carry the strategy id only when copying', () => {
    expect(withCopiedStrategy({ strategy: 'custom' }, null)).toEqual({ strategy: 'custom' });
    expect(withCopiedStrategy({ strategy: 'custom' }, copyOf(creator))).toEqual({ strategy: 'custom', strategyId: '0b7d9c4e-1f2a-4c3b-9d8e-7f6a5b4c3d2e' });
  });
});

describe('dialog text (golden from the C# interpolations)', () => {
  it('"{bps / 100.0:0.#}" for every share up to 20 % and beyond', () => {
    for (const [bps, text] of Object.entries(golden.feePercent)) expect(feePercent(Number(bps))).toBe(text);
    expect(format0Hash(2)).toBe('2');
    expect(format0Hash(0.15)).toBe('0.2');
  });

  for (const m of golden.messages) {
    it(`Copy / deploy lines for ${m.name}`, () => {
      const c = copyOf(m.creator, m.creatorFeeBps, m.platformFeeBps, m.name);
      expect(solCopyMessage(c, m.creatorName, true)).toEqual([m.ownTitle, m.ownBody]);
      expect(solCopyMessage(c, m.creatorName, false)).toEqual([m.copyTitle, m.copyBody]);
      expect(deployBusyText(c)).toBe(m.busy);
      expect(deployedText('$250', c)).toBe('It plays SOL tables with up to $250 at risk. If no table has players, it opens one.' + m.deployedSuffix);
    });
  }

  it('no copy: the plain lines', () => {
    expect(deployBusyText(null)).toBe('Setting your Agent on chain (your play key signs; no wallet prompt)…');
    expect(deployedText('$250', null)).toBe('It plays SOL tables with up to $250 at risk. If no table has players, it opens one.');
  });
});

describe('SolProfile after ApplyProfile (Newtonsoft golden)', () => {
  for (const g of golden.profiles) {
    it(g.input.slice(0, 60), () => {
      const s = new AgentStrategyState(new MemStore());
      applyProfileTo(s, JSON.parse(g.input));
      expect(solProfile(s)).toEqual(JSON.parse(g.solProfile));
    });
  }
});

// ------------------------------------------------------------------------------ the Market dialogs, ONCHAIN

type Btn = { label: string; onClick: () => void; scale: [number, number] };

function fakeHost(onchain: boolean, strategy: AgentStrategyState) {
  const buttons: Btn[] = [];
  const lines: string[] = [];
  const messages: [string, string][] = [];
  const node = {};
  const host = {
    onchain,
    ctx: { services: { agentStrategy: strategy }, events: { emit() {} } },
    dialogs: {
      panel: (title: string) => (lines.push(title), node),
      line: (_p: unknown, text: string) => (lines.push(text), node),
      button: (_p: unknown, label: string, _y: boolean, _pos: unknown, onClick: () => void) => {
        const b: Btn = { label, onClick, scale: [1, 1] };
        buttons.push(b);
        return b;
      },
      scrollList: () => node,
      row: () => node,
      close: () => {},
    },
    message: (title: string, body: string) => void messages.push([title, body]),
    busy: () => {},
  };
  return { host: host as unknown as NomadHost, buttons, lines, messages };
}

const listing = (over: Record<string, unknown> = {}) => ({
  strategyId: '5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9', name: 'River Rat', version: 3, creator: new PublicKey(fill(9)).toBase58(), creatorName: 'Alice',
  listed: true, qualified: true, verified: false, tags: ['tight'], style: 'Trapper',
  profile: { foldBelow: 0.4, raiseAbove: 0.65, aggression: 0.55, bluffChance: 0.05, raiseFractionOfPot: 0.7, positionWeight: 0.2, brain: 2 },
  record: { copiers: 2, sessions: 5, hands: 1500, net: -25000, per100Hands: 120, bb100: 4, se100: 2, swing: 3.4, vsHouse: 1 },
  listing: { minHands: 1000, minDays: 3, house: 3 },
  fees: { creatorBps: 800, creatorPercent: 8, platformBps: 200, platformPercent: 2 },
  ...over,
});

describe('Market in ONCHAIN mode', () => {
  it('lists the SOL marketplace (public GET), copies a strategy and marks it Copying', () => {
    const strategy = new AgentStrategyState(new MemStore());
    const { host, buttons, lines, messages } = fakeHost(true, strategy);
    const calls: [string, string, boolean][] = [];
    marketOnchain.loadSol = (title, path, show, signed) => {
      calls.push([title, path, signed]);
      show({ strategies: [listing()] });
    };
    marketOnchain.walletAddress = () => wallet.toBase58();
    openMarket(host, 'top');
    expect(calls).toEqual([['Marketplace', '/sol-strategies?sort=top', false]]);
    expect(lines[0]).toBe('SOL strategy marketplace');
    expect(buttons.slice(0, 3).map((b) => b.label)).toEqual(['Top', 'Popular', 'New']);
    buttons.find((b) => b.label === 'Copy')!.onClick();

    expect(marketState.copiedSol).toEqual({ id: '5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9', name: 'River Rat', creator: new PublicKey(fill(9)).toBase58(), creatorFeeBps: 800, platformFeeBps: 200 });
    expect(marketState.copiedStrategyId).toBeNull(); // the Coins copy is a different one
    expect(messages.at(-1)![0]).toBe('Copying River Rat');
    expect(messages.at(-1)![1]).toContain('to pay 8% of new profit to the creator and 2% to Nomad');
    // The Agent now plays the strategy's profile, which deploy sends back.
    expect(solProfile(strategy)).toEqual({ foldBelow: 0.4, raiseAbove: 0.65, aggression: 0.55, bluffChance: 0.05, raiseFractionOfPot: 0.7, positionWeight: 0.2, brain: 2 });

    buttons.length = 0;
    openMarket(host, 'top');
    expect(buttons.some((b) => b.label === 'Copying')).toBe(true);
  });

  it('editing the sliders stops copying (and its fee); an unchanged edit keeps it', () => {
    const strategy = new AgentStrategyState(new MemStore());
    const { host, buttons } = fakeHost(true, strategy);
    marketOnchain.loadSol = (_t, _p, show) => show({ strategies: [listing()] });
    openMarket(host, 'top');
    buttons.find((b) => b.label === 'Copy')!.onClick();
    onStrategyEdited(strategy);
    expect(marketState.copiedSol).not.toBeNull();
    strategy.applyAll(4, [0.1, 0.65, 0.55, 0.05, 0.7], strategy.positionWeight, strategy.brain, strategy.streets);
    onStrategyEdited(strategy);
    expect(marketState.copiedSol).toBeNull();
    expect(marketState.copiedName).toBeNull();
  });

  it('My strategies (signed): SOL earnings and Run, which plays your own with no fee', () => {
    const strategy = new AgentStrategyState(new MemStore());
    const { host, buttons, lines, messages } = fakeHost(true, strategy);
    const calls: [string, string, boolean][] = [];
    marketOnchain.loadSol = (title, path, show, signed) => {
      calls.push([title, path, signed]);
      show({ strategies: [listing({ creator: wallet.toBase58(), name: 'Mine' }), listing({ listed: false, name: 'Old' })], earned: '1250000' });
    };
    marketOnchain.walletAddress = () => wallet.toBase58();
    marketOnchain.sol = (l) => '$' + (Number(l) / 100_000).toFixed(2);
    openMyStrategies(host);
    expect(calls).toEqual([['My strategies', '/sol-strategies/mine', true]]);
    expect(lines).toContain('Earned from copiers: $12.50, paid into your game balance on chain');
    expect(lines).toContain('−$0.25 for copiers');
    const runs = buttons.filter((b) => b.label === 'Run');
    expect(runs.length).toBe(1); // only the listed version
    runs[0]!.onClick();
    expect(messages.at(-1)).toEqual(solCopyMessage(marketState.copiedSol!, 'Alice', true));
    expect(messages.at(-1)![0]).toBe('Running Mine');
  });

  it('DEMO keeps the Coins marketplace and its copy', () => {
    const { host, buttons, lines } = fakeHost(false, new AgentStrategyState(new MemStore()));
    const calls: string[] = [];
    (host.ctx.services as unknown as Record<string, unknown>).backendApi = {
      call: async (_m: string, path: string) => (calls.push(path), { ok: true, body: JSON.stringify({ strategies: [listing()] }), error: '' }),
    };
    openMarket(host, 'styles');
    return new Promise<void>((r) => setTimeout(r, 0)).then(() => {
      expect(calls).toEqual(['/api/strategies?sort=styles']);
      expect(lines).toContain('Strategy marketplace');
      buttons.find((b) => b.label === 'Copy')!.onClick();
      expect(marketState.copiedStrategyId).toBe('5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9');
      expect(marketState.copiedSol).toBeNull();
    });
  });
});

describe('PerAgent.get (LoadSol unsigned)', () => {
  const http = (status: number, body: string): PerHttp => ({ get: async () => ({ status, body }), post: async () => ({ status, body }), delay: async () => {} });
  it('needs a backend, and reads errors as the C#', async () => {
    await expect(PerAgent.get(http(200, '{}'), '', '/sol-strategies?sort=top')).rejects.toThrow(NO_PER_BACKEND);
    await expect(PerAgent.get(http(500, '{"error":"db down"}'), 'http://x', '/sol-strategies')).rejects.toThrow('db down');
    await expect(PerAgent.get(http(502, 'bad gateway'), 'http://x', '/sol-strategies')).rejects.toThrow('HTTP 502');
    await expect(PerAgent.get(http(200, '{"strategies":[]}'), 'http://x', '/sol-strategies')).resolves.toEqual({ strategies: [] });
  });
});
