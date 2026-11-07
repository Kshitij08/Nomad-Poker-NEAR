/**
 * Port of NomadUiHost.Market.cs: Agents v2 in the menu — "My Twin" (an Agent that plays like you), the copy-strategy
 * marketplace (copiers pay 8 % of new profit to the creator and 2 % to Nomad) and coaching. The art has no screens for
 * these: they are Nomad dialogs opened from three buttons added to the Agents screens' header bar.
 *
 * Backend calls go through the optional `backendApi` service (TournamentApiClient.CallAsync); with no backend the
 * dialogs say the service is offline. Applying a strategy goes to the agents module's `agentStrategy` service
 * (AgentStrategyState). In ONCHAIN mode the same dialogs show the SOL marketplace (per/backend solStrategies.ts): its
 * requests (LoadSol: public GETs, or requests signed by the play key) and the wallet address come from the web3
 * partial through `marketOnchain`, and Copy sets `marketState.copiedSol`, the strategy the next SOL Agent plays under
 * its fee terms (NomadUiHost.Onchain OnchainDeployOrStop, in web3/nomad/onchainPartial.ts).
 *
 * Like the C# statics, the copy lives for the app session only (no PlayerPrefs key): after a reload the Strategy tab
 * still holds the copied numbers (AgentStrategyState saves them) but they run as the player's own, with no fee.
 */
import type { UNode } from '../../hud/unityUi';
import type { AppContext } from '../../app/app';
import { formatN0 } from '../../core';
import type { NomadHost } from '../host';
import type { BackendApiLike } from '../deps';

const AGENT_SCREENS = ['Agents_Overview', 'Agents_Strategy', 'Agents_SessionHistory'];
const GOOD = { r: 0.4, g: 0.9, b: 0.5, a: 1 };
const BAD = { r: 0.95, g: 0.45, b: 0.45, a: 1 };
const SOFT = { r: 0.66, g: 0.72, b: 0.88, a: 1 };
const WHITE = { r: 1, g: 1, b: 1, a: 1 };
const TWIN_MIN_DECISIONS = 30;
const COACH_MIN_HANDS = 20;
/** AgentStrategyWords.Names (agents module owns the wording; these are its five parameter names). */
const PARAM_NAMES = ['Folds below', 'Raises above', 'Aggression', 'Bluffs', 'Bet size'];

/** AgentStrategyState (agents module). */
export interface AgentStrategyLike {
  readonly values: number[];
  readonly streets: (number[] | null)[];
  applyAll(preset: number, values: number[], positionWeight: number, brain: number, streets: (number[] | null)[]): void;
  /** Subscribe to slider edits; returns an unsubscribe. */
  onChanged(fn: () => void): () => void;
  /** AgentStrategyWords.Tag(i, values): a parameter in words. */
  tag?(i: number, values: number[]): string;
  readonly brainClassic?: number;
  readonly brainSmart?: number;
  /** SolProfile's optional Agents v2 fields. */
  readonly positionWeight?: number;
  readonly brain?: number;
  readonly hasStreets?: boolean;
}

/**
 * NomadUiHost.SolCopy: the SOL marketplace strategy the next SOL Agent copies. Its fee terms are set on chain with the
 * Agent (OnchainDeployOrStop), and the program pays them at every cash-out.
 */
export interface SolCopy {
  id: string;
  name: string;
  /** The creator's wallet (base58): the program pays the creator's share into its game balance. */
  creator: string;
  creatorFeeBps: number;
  platformFeeBps: number;
}

/** SolCopy.Own: the player's own strategy runs with no fee (the program refuses a creator paying themselves). */
export function solCopyIsOwn(copy: SolCopy, walletAddress: string | null | undefined): boolean {
  return walletAddress != null && copy.creator === walletAddress;
}

/** The SOL marketplace's way to the network and the wallet (set by the web3 partial; NomadUiHost.Onchain's half). */
export const marketOnchain: {
  /** NomadUiHost.LoadSol: Busy, then GET the private-tables backend + path, or (signed) connect the wallet and post a
   * request signed by the play key; `show` gets the JSON, an error goes to a message box. */
  loadSol?: (title: string, path: string, show: (j: Record<string, unknown>) => void, signed: boolean, data: Record<string, unknown> | null) => void;
  /** PerWallet.Address (base58), or null with no wallet connected. */
  walletAddress?: () => string | null;
  /** PerUi.Sol: lamports as "$12.50". */
  sol?: (lamports: bigint) => string;
} = {};

/** The marketplace strategy the next Coins Agent copies (null: the player's own sliders). Read by the agents partial. */
export const marketState = {
  copiedStrategyId: null as string | null,
  /** ONCHAIN: the SOL marketplace strategy the next SOL Agent copies (null: the player's own sliders). */
  copiedSol: null as SolCopy | null,
  copiedName: null as string | null,
  copiedValues: null as number[] | null,
  copiedStreets: null as (number[] | null)[] | null,
};

type J = Record<string, unknown>;
const arr = (v: unknown): J[] => (Array.isArray(v) ? (v as J[]) : []);
const num = (v: unknown) => Number(v ?? 0);
const signedCoins = (v: number) => (v >= 0 ? '+' : '−') + formatN0(Math.abs(v));
const pct = (v: unknown) => Math.round(num(v) * 100) + '%';

/** C#'s `{x:0.#}` (invariant): one decimal at most, rounded half away from zero on the 15-digit value, as .NET does. */
export function format0Hash(x: number): string {
  const neg = x < 0;
  const tenths = Math.round(Number((Math.abs(x) * 10).toPrecision(15)));
  const s = String(Math.floor(tenths / 10)) + (tenths % 10 ? '.' + (tenths % 10) : '');
  return neg && tenths !== 0 ? '-' + s : s;
}

/** A fee share as the dialogs print it: `{bps / 100.0:0.#}` ("8", "2.5"). */
export const feePercent = (bps: number): string => format0Hash(bps / 100);

/** The shortest number that reads back as the same float32: how Newtonsoft writes a C# float (`R`), so a copied 0.35
 * goes back to the Agent service as 0.35, not 0.3499999940395355. */
function floatJson(v: number): number {
  const fv = Math.fround(v);
  for (let p = 1; p <= 9; p++) {
    const s = Number(fv.toPrecision(p));
    if (Math.fround(s) === fv) return s;
  }
  return fv;
}

/**
 * NomadUiHost.Onchain SolProfile: the Strategy tab as the backends' strategy profile (agentBot.ts Profile, also what
 * Publish sends): the five numbers, then the optional Agents v2 fields (position, brain 2, betting rounds with their own
 * numbers keyed preflop / flop / turn / river).
 */
export function solProfile(st: AgentStrategyLike | undefined): Record<string, unknown> {
  const v = st?.values ?? [0.3, 0.7, 0.5, 0.1, 0.5];
  const five = (x: number[]) => ({ foldBelow: floatJson(x[0]!), raiseAbove: floatJson(x[1]!), aggression: floatJson(x[2]!), bluffChance: floatJson(x[3]!), raiseFractionOfPot: floatJson(x[4]!) });
  const p: Record<string, unknown> = five(v);
  if (st && (st.positionWeight ?? 0) > 0) p.positionWeight = floatJson(st.positionWeight!);
  if (st && st.brain !== undefined && st.brain === (st.brainSmart ?? 2)) p.brain = 2;
  if (st && (st.hasStreets ?? st.streets.some((s) => s != null))) {
    const keys = ['preflop', 'flop', 'turn', 'river'];
    const streets: Record<string, unknown> = {};
    st.streets.forEach((s, i) => {
      if (s && i < 4) streets[keys[i]!] = five(s);
    });
    p.streets = streets;
  }
  return p;
}

/** Copy's message for a SOL strategy: [title, body]. `own`: the player's own strategy (no fee). */
export function solCopyMessage(copy: SolCopy, creatorName: string, own: boolean): [string, string] {
  if (own)
    return ['Running ' + copy.name, `Your next SOL Agent plays your own "${copy.name}", with no fee. Its sessions build the record others need before they can copy it. Deploy it from Overview.`];
  return ['Copying ' + copy.name, `Your next SOL Agent plays "${copy.name}" by ${creatorName}. Deploy it from Overview: your play key then agrees, on chain, ` +
    `to pay ${feePercent(copy.creatorFeeBps)}% of new profit to the creator and ${feePercent(copy.platformFeeBps)}% to Nomad whenever its seat cashes out, even if you take the seat back yourself (never on losses). Changing the sliders stops copying.`];
}

/** A listing's copy terms (Copy, ONCHAIN): the id, name, creator and the shares its `fees` name. */
export function solCopyOf(s: Record<string, unknown>): SolCopy {
  const fees = (s.fees ?? {}) as Record<string, unknown>;
  return { id: String(s.strategyId), name: String(s.name), creator: String(s.creator), creatorFeeBps: Math.trunc(num(fees.creatorBps)), platformFeeBps: Math.trunc(num(fees.platformBps)) };
}

export function bindMarket(host: NomadHost): void {
  const ctx = host.ctx;
  const strat = () => (ctx.services as unknown as Record<string, unknown>).agentStrategy as AgentStrategyLike | undefined;
  for (const screen of AGENT_SCREENS) {
    const header = host.find(screen, 'AgentHeader');
    if (!header || host.find(header, 'Btn_Twin')) continue;
    const xs = [-230, 0, 230];
    const labels = ['My Twin', 'Marketplace', 'Coach'];
    const actions = [() => openTwin(host), () => openMarket(host, host.onchain ? 'top' : 'styles'), () => openCoach(host)];
    const names = ['Btn_Twin', 'Btn_Market', 'Btn_Coach'];
    for (let i = 0; i < 3; i++) {
      const b = host.dialogs.button(header, labels[i]!, i === 1, [xs[i]! + 60, 0], actions[i]!, 210);
      b.el.dataset.name = names[i]!;
      (b as { name: string }).name = names[i]!;
      b.scale = [0.62, 0.62];
    }
  }
  // Editing the sliders away from a copied strategy stops copying it.
  let unsub: (() => void) | null = null;
  const hook = () => {
    const s = strat();
    if (!s || unsub) return;
    unsub = s.onChanged(() => onStrategyEdited(s));
  };
  hook();
  host.onRefresh(hook);
}

/** OnStrategyEdited: any change (the main numbers or a betting round's own) stops copying, and its fee. */
export function onStrategyEdited(s: AgentStrategyLike): void {
  if ((marketState.copiedStrategyId === null && marketState.copiedSol === null) || !marketState.copiedValues) return;
  if (!same(s.values, marketState.copiedValues)) return stopCopying();
  for (let r = 0; r < 4; r++) if (!same(s.streets[r] ?? null, marketState.copiedStreets?.[r] ?? null)) return stopCopying();
}

/** StopCopying: the player's own sliders again (no strategy id, no SOL fee terms). */
export function stopCopying(): void {
  marketState.copiedStrategyId = null;
  marketState.copiedSol = null;
  marketState.copiedName = null;
}

function same(a: number[] | null, b: number[] | null): boolean {
  if (!a || !b) return a === b;
  for (let i = 0; i < 5 && i < a.length && i < b.length; i++) if (Math.abs(a[i]! - b[i]!) > 0.005) return false;
  return true;
}

function api(ctx: AppContext): BackendApiLike | undefined {
  return (ctx.services as unknown as Record<string, unknown>).backendApi as BackendApiLike | undefined;
}

/** Load: Busy, call, then show the JSON (or the error). */
async function load(host: NomadHost, title: string, method: string, path: string, show: (j: J) => void, json: string | null = null, auth = true): Promise<void> {
  const a = api(host.ctx);
  if (!a) {
    host.message(title, 'The Agent service is offline in this build.');
    return;
  }
  host.busy(title, 'Loading…');
  const r = await a.call(method, path, json, auth);
  if (!r.ok) return host.message(title, r.error);
  try {
    show(JSON.parse(r.body) as J);
  } catch (e) {
    console.error(e);
    host.message(title, 'The service sent something unexpected. Try again.');
  }
}

/** LoadSol (the web3 partial's); without the web3 module there is no SOL marketplace. */
function loadSol(host: NomadHost, title: string, path: string, show: (j: J) => void, signed = false, data: J | null = null): void {
  if (!marketOnchain.loadSol) return host.message(title, 'The SOL marketplace needs the web3 module.');
  marketOnchain.loadSol(title, path, show, signed, data);
}

/** PerUi.Sol (the web3 partial's), or dollars at $1 = 100,000 lamports. */
const solText = (lamports: bigint): string => marketOnchain.sol?.(lamports) ?? '$' + formatN0(Number(lamports) / 100_000);

/** Money: signed Coins, or $ in ONCHAIN mode (lamports). */
function money(host: NomadHost, v: number): string {
  return host.onchain ? (v >= 0 ? '+' : '−') + solText(BigInt(Math.trunc(Math.abs(v)))) : signedCoins(v);
}

const strategyOf = (host: NomadHost) => (host.ctx.services as unknown as Record<string, unknown>).agentStrategy as AgentStrategyLike | undefined;

const valuesOf = (p: J) => [num(p.foldBelow), num(p.raiseAbove), num(p.aggression), num(p.bluffChance), num(p.raiseFractionOfPot)];

/** A backend strategy profile as the Agent's whole strategy (five numbers, position, brain, betting rounds). */
function applyProfile(host: NomadHost, p: J): void {
  const s = strategyOf(host);
  if (s) applyProfileTo(s, p);
}

/** ApplyProfile on a given AgentStrategyState. */
export function applyProfileTo(s: AgentStrategyLike, p: J): void {
  const st = p.streets as J | undefined;
  const streets = ['preflop', 'flop', 'turn', 'river'].map((k) => (st?.[k] && typeof st[k] === 'object' ? valuesOf(st[k] as J) : null));
  const pw = typeof p.positionWeight === 'number' ? p.positionWeight : 0;
  const brain = p.brain === 2 ? (s.brainSmart ?? 2) : (s.brainClassic ?? 1);
  s.applyAll(3, valuesOf(p), pw, brain, streets);
}

function rememberCopy(host: NomadHost): void {
  const s = (host.ctx.services as unknown as Record<string, unknown>).agentStrategy as AgentStrategyLike | undefined;
  marketState.copiedValues = s ? [...s.values] : null;
  marketState.copiedStreets = s ? s.streets.map((r) => (r ? [...r] : null)) : null;
}

// ------------------------------------------------------------------------------ My Twin

function openTwin(host: NomadHost): void {
  void load(host, 'My Twin', 'GET', '/api/style/twin', (t) => showTwin(host, t));
}

function showTwin(host: NomadHost, t: J): void {
  const d = host.dialogs;
  const n = num(t.decisions);
  const conf = num(t.confidence);
  if (n < TWIN_MIN_DECISIONS) {
    const empty = d.panel('My Twin', [1000, 480]);
    d.line(empty, `Your twin learns how you play from your Coins hands.\nIt has ${n} of the ${TWIN_MIN_DECISIONS} decisions it needs: play a few more hands.`, 30, [0, 40], [860, 140], SOFT, 'center');
    return;
  }
  const panel = d.panel('My Twin', [1100, 720]);
  const match = t.matchRate === null || t.matchRate === undefined ? 'learning…' : `plays like you ${pct(t.matchRate)} of the time`;
  d.line(panel, n === 0 ? 'Play some Coins hands: your twin learns from every decision you make.' : `Learned from ${formatN0(n)} of your decisions (${Math.round(conf * 100)}% sure) · ${match}`, 30, [0, 200], [980, 50], SOFT, 'center');
  if (Array.isArray(t.tags)) d.line(panel, (t.tags as string[]).join(' · '), 34, [0, 140], [980, 50], WHITE, 'center');
  const p = t.profile as J;
  const v = valuesOf(p);
  const s = (host.ctx.services as unknown as Record<string, unknown>).agentStrategy as AgentStrategyLike | undefined;
  for (let i = 0; i < 5; i++) {
    d.line(panel, PARAM_NAMES[i]!, 28, [-260, 70 - i * 56], [380, 44], SOFT);
    d.line(panel, s?.tag?.(i, v) ?? `${Math.round(v[i]! * 100)}%`, 30, [230, 70 - i * 56], [420, 44], WHITE, 'right');
  }
  d.button(panel, 'Use my twin', true, [-340, -290], () => {
    d.close();
    marketState.copiedStrategyId = null;
    marketState.copiedSol = null;
    marketState.copiedName = null;
    applyProfile(host, p);
    host.message('My Twin', 'Your Agent now plays like you (Custom on the Strategy tab). Deploy it from Overview.');
  }, 280);
  d.button(panel, 'Publish', false, [-40, -290], () => publishPrompt(host, true), 260);
}

function publishPrompt(host: NomadHost, fromTwin: boolean): void {
  if (host.onchain) {
    if (fromTwin) return host.message('Publish', "Your twin learns from Coins hands: publish it in DEMO, or publish your Strategy tab's settings here.");
    host.message('Publish a SOL strategy', "Name the strategy on your Strategy tab. Copiers' Agents pay 8% of the profit they make with it into your game balance, on chain.",
      'Publish', undefined, 'Cancel', undefined, 'Strategy name', (name) => {
        const body = { name, profile: solProfile(strategyOf(host)) };
        loadSol(host, 'Publish', '/sol-strategies/publish', (r) => host.message('Published',
          `"${r.name}" (v${r.version}) is in the SOL marketplace. You get 8% of copiers' new profit; Nomad ${format0Hash(num(((r.fees ?? {}) as J).platformPercent))}%.`), true, body);
      });
    return;
  }
  host.message('Publish a strategy', fromTwin ? 'Name your twin\'s strategy. Copiers pay you 8% of the profit they make with it.' : 'Name the strategy on your Strategy tab. Copiers pay you 8% of the profit they make with it.',
    'Publish', undefined, 'Cancel', undefined, 'Strategy name', (name) => {
      // The Coins marketplace takes the same profile as the SOL one (C#: SolProfile(v) in both).
      const body = fromTwin ? { name, fromTwin: true } : { name, profile: solProfile(strategyOf(host)) };
      void load(host, 'Publish', 'POST', '/api/strategies', (r) => host.message('Published', `"${r.name}" (v${r.version}) is in the marketplace. You get 8% of copiers' profit; Nomad 2%.`), JSON.stringify(body));
    });
}

// ------------------------------------------------------------------------------ marketplace

export function openMarket(host: NomadHost, sort: string): void {
  if (host.onchain) return loadSol(host, 'Marketplace', '/sol-strategies?sort=' + sort, (j) => showMarket(host, j, sort));
  void load(host, 'Marketplace', 'GET', '/api/strategies?sort=' + sort, (j) => showMarket(host, j, sort), null, false);
}

function showMarket(host: NomadHost, j: J, sort: string): void {
  const d = host.dialogs;
  const onchain = host.onchain;
  const panel = d.panel(onchain ? 'SOL strategy marketplace' : 'Strategy marketplace', [1500, 900]);
  d.line(panel, onchain
    ? 'Copy a strategy for your SOL Agent. Its creator gets 8% and Nomad 2% of the new profit it makes you, paid on chain; never of losses.'
    : 'Copy a strategy for your Coins Agent. Its creator gets 8% and Nomad 2% of the profit it makes you, never of losses.', 24, [0, 312], [1380, 40], SOFT, 'center');
  // Coins: one lane per style first, so every style shows, then New and promising, Top, Popular.
  const sorts = onchain ? ['top', 'popular', 'new'] : ['styles', 'new', 'top', 'popular'];
  const sortLabels = onchain ? ['Top', 'Popular', 'New'] : ['By style', 'Promising', 'Top', 'Popular'];
  const sortW = onchain ? 200 : 170;
  sorts.forEach((s, i) => (d.button(panel, sortLabels[i]!, s === sort, [-590 + i * sortW, 248], () => openMarket(host, s), sortW - 10).scale = [0.8, 0.8]));
  d.button(panel, 'My strategies', false, [330, 248], () => openMyStrategies(host), 280).scale = [0.8, 0.8];
  d.button(panel, 'Publish', false, [590, 248], () => publishPrompt(host, false), 220).scale = [0.8, 0.8];
  const list = d.scrollList(panel, [-700, 200, 1400, 450]);
  const items = arr(j.strategies);
  if (!items.length) d.line(list, 'No strategies yet. Publish yours: from My Twin, or your Strategy tab.', 26, [0, 0], [1300, 60], SOFT, 'center');
  for (const s of items) {
    const row = d.row(list, 120);
    const rec = (s.record ?? {}) as J;
    const verified = s.verified ? ' · verified' : '';
    d.line(row, `${s.name}  <size=70%><color=#A9B4D8>v${s.version} · by ${s.creatorName}${verified}</color></size>`, 30, [-260, 26], [820, 44]);
    const style = typeof s.style === 'string' ? s.style + ' · ' : '';
    d.line(row, style + ((s.tags as string[] | undefined) ?? []).join(' · '), 22, [-260, -22], [820, 36], SOFT);
    const copying = (onchain ? marketState.copiedSol?.id ?? null : marketState.copiedStrategyId) === (s.strategyId ?? null);
    if (typeof rec.bb100 === 'number') {
      const bb = num(rec.bb100), vs = num(rec.vsHouse);
      const margin = typeof rec.se100 === 'number' ? ` ± ${rec.se100}` : '';
      d.line(row, `${bb >= 0 ? '+' : ''}${bb} bb/100${margin}\n<size=75%>${vs >= 0 ? '+' : ''}${vs} vs Autopilot · swing ${Math.round(num(rec.swing))} bb · ${formatN0(num(rec.hands))} hands</size>`, 26, [300, 0], [330, 90], vs >= 0 ? GOOD : BAD, 'right');
      const canCopy = !!s.qualified;
      d.button(row, copying ? 'Copying' : canCopy ? 'Copy' : 'Not yet', canCopy, [570, 0], () => (canCopy ? copy(host, s) : notCopyableYet(host, s)), 200).scale = [0.8, 0.8];
    } else {
      const per100 = num(rec.per100Hands);
      d.line(row, `${money(host, per100)} / 100 hands\n<size=75%>${num(rec.copiers)} copiers · ${formatN0(num(rec.hands))} hands</size>`, 26, [300, 0], [300, 90], per100 >= 0 ? GOOD : BAD, 'right');
      d.button(row, copying ? 'Copying' : 'Copy', true, [570, 0], () => copy(host, s), 200).scale = [0.8, 0.8];
    }
  }
  host.ctx.events.emit('menu:dialog');
}

function notCopyableYet(host: NomadHost, s: J): void {
  const rec = (s.record ?? {}) as J;
  const need = (s.listing ?? {}) as J;
  const bb = num(rec.bb100);
  host.message(String(s.name), `Not copyable yet. A strategy needs ${formatN0(num(need.minHands))} hands over ${num(need.minDays)} days, and a result that beats Autopilot (+${num(need.house)} bb/100) by more than its margin. ` +
    `It has ${formatN0(num(rec.hands))} hands at ${bb >= 0 ? '+' : ''}${bb} bb/100.`);
}

function copy(host: NomadHost, s: J): void {
  marketState.copiedStrategyId = null;
  marketState.copiedSol = null;
  applyProfile(host, (s.profile ?? {}) as J);
  if (host.onchain) {
    const c = solCopyOf(s);
    marketState.copiedSol = c;
    marketState.copiedName = c.name;
    rememberCopy(host);
    host.dialogs.close();
    const [title, body] = solCopyMessage(c, String(s.creatorName), solCopyIsOwn(c, marketOnchain.walletAddress?.() ?? null));
    host.message(title, body);
    return;
  }
  marketState.copiedStrategyId = String(s.strategyId);
  marketState.copiedName = String(s.name);
  rememberCopy(host);
  host.dialogs.close();
  host.message('Copying ' + marketState.copiedName, `Your next Coins Agent plays "${marketState.copiedName}" by ${s.creatorName}. Deploy it from Overview. ` +
    'When it wins, 8% of the new profit goes to the creator and 2% to Nomad; changing the sliders stops copying.');
}

export function openMyStrategies(host: NomadHost): void {
  if (host.onchain) return loadSol(host, 'My strategies', '/sol-strategies/mine', (j) => showMyStrategies(host, j), true);
  void load(host, 'My strategies', 'GET', '/api/strategies/mine', (j) => showMyStrategies(host, j));
}

function showMyStrategies(host: NomadHost, j: J): void {
  const d = host.dialogs;
  const panel = d.panel('My strategies', [1300, 820]);
  const mine = arr(j.strategies);
  const onchain = host.onchain;
  // The earnings line only once there is something to report (the empty note says the rest).
  if (mine.length) d.line(panel, onchain ? `Earned from copiers: ${solText(BigInt(String(j.earned ?? '0')))}, paid into your game balance on chain`
    : `Earned from copiers: ${formatN0(num(j.earned))} Coins  ·  paid out: ${formatN0(num(j.paid))}`, 30, [0, 262], [1200, 50], GOOD, 'center');
  const list = d.scrollList(panel, [-600, 220, 1200, 420]);
  if (!mine.length) {
    d.line(list, "You haven't published a strategy yet. Publish your Strategy tab's settings (or your twin) and copiers pay you 8% of the profit it makes them.", 26, [0, 0], [1100, 120], SOFT, 'center');
    d.button(panel, 'Publish', true, [-170, -340], () => publishPrompt(host, false), 260);
  }
  for (const s of mine) {
    const row = d.row(list, 100);
    const rec = (s.record ?? {}) as J;
    const need = (s.listing ?? {}) as J;
    const vs = num(rec.vsHouse);
    const state = !s.listed ? ' · old version' : s.qualified ? ' · copyable'
      : need.minDays !== undefined ? ` · not copyable yet: ${formatN0(num(rec.hands))}/${formatN0(num(need.minHands))} hands, ${num(need.minDays)} days, beat Autopilot (${vs >= 0 ? '+' : ''}${vs} now)`
        : ` · not listed yet: ${formatN0(num(rec.hands))}/${formatN0(num(need.minHands))} hands, needs a profit`;
    d.line(row, `${s.name}  <size=70%><color=#A9B4D8>v${s.version}${state}</color></size>`, 30, [-260, 18], [620, 44]);
    d.line(row, `${num(rec.copiers)} copiers · ${num(rec.sessions)} sessions · ${formatN0(num(rec.hands))} hands`, 22, [-260, -24], [620, 36], SOFT);
    d.line(row, money(host, num(rec.net)) + ' for copiers', 26, [onchain ? 230 : 380, 0], [400, 50], num(rec.net) >= 0 ? GOOD : BAD, 'right');
    if (onchain && s.listed) {
      // SOL: creators can always run their own strategy (no fee); that's how it reaches the listing minimum.
      d.button(row, 'Run', true, [510, 0], () => copy(host, s), 160).scale = [0.8, 0.8];
    }
  }
}

// ------------------------------------------------------------------------------ coaching

function openCoach(host: NomadHost): void {
  void load(host, 'Coach', 'GET', '/api/style/coach', (r) => showCoach(host, r));
}

function showCoach(host: NomadHost, r: J): void {
  const d = host.dialogs;
  const st = (r.stats ?? {}) as J;
  const hands = num(r.hands);
  if (hands < COACH_MIN_HANDS) {
    const empty = d.panel('Your coach', [1000, 480]);
    d.line(empty, `The coach learns from your Coins hands.\nPlay ${COACH_MIN_HANDS - hands} more, then come back for what's working and what to try.`, 30, [0, 40], [860, 140], SOFT, 'center');
    return;
  }
  const panel = d.panel('Your coach', [1400, 880]);
  d.line(panel, `${formatN0(hands)} hands · ${num(st.bbPer100).toFixed(1)} bb/100 · plays ${pct(st.vpip)} · raises ${pct(st.pfr)} · wins ${pct(st.wonAtShowdown)} of showdowns`, 26, [0, 296], [1300, 44], SOFT, 'center');
  const list = d.scrollList(panel, [-650, 262, 1300, 500]);
  const card = (text: string, color: typeof WHITE, height: number) => {
    const row = d.row(list, height);
    const t: UNode = d.line(row, text, 26, [0, 0], [1220, height - 16], color);
    t.anchorMin = [0, 0];
    t.anchorMax = [1, 1];
    t.sizeDelta = [-48, -16];
    t.anchoredPosition = [0, 0];
    t.layout();
  };
  if (typeof r.note === 'string' && r.note) card(r.note, WHITE, 200);
  for (const w of (r.working as string[] | undefined) ?? []) card('+ ' + w, GOOD, 80);
  for (const l of arr(r.notWorking)) card(`<b>${l.title}</b>\n<size=80%>${l.detail}</size>\n<size=80%><color=#9FE3FF>Try: ${l.advice}</color></size>`, BAD, 150);
  card('<b>Try next:</b> ' + String(r.tryNext ?? ''), { r: 0.62, g: 0.89, b: 1, a: 1 }, 90);
}
