/**
 * 'private-tourneys': Per/Unity/PerTourneyPanel.cs — on-chain tournaments (M11): the list from the private-tables
 * backend (every 5 s while open), Host, Register / Leave / Cancel (play key: no wallet prompt), Enter code, and
 * "Go to your table" once a round runs. 'private-tourney-host': PerTourneyHostPanel (same file in Unity).
 */
import { PublicKey } from '@solana/web3.js';
import type { AppContext } from '../../app/app';
import { noPerBackend } from '../per/agent';
import { PerSessionKeys } from '../per/keys';
import { PerRpc } from '../per/rpc';
import type { PerRuntime } from '../per/service';
import type { TourneyParams } from '../per/types';
import type { PlayKey } from '../per/vault';
import type { TransactionInstruction } from '@solana/web3.js';
import { u64 } from './lobby';
import { closeScreen, type PanelFactory, type PanelImpl } from './lazy';
import { ask, box, button, clear, column, copyText, errMsg, line, logStatus, PerCanvas, PerColor, text, type PerButton, type PerText } from './perUi';
import { w3 } from '../services';

type Json = Record<string, unknown>;
const int = (v: unknown): number => Number(v ?? 0) | 0;
const num = (v: unknown): number => Number(v ?? 0) || 0;
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** "2 h 5 min" / "12 min" / "40 s". */
export const span = (s: number): string => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : s >= 60 ? `${Math.floor(s / 60)} min` : `${s} s`);
/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st. */
export const ordinal = (n: number): string => n + ([11, 12, 13].includes(n % 100) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th');

/** PerTourneyHostPanel.CodeBytes: a code as the 16 bytes the program hashes (ASCII, upper case, zero padded). */
export function codeBytes(textIn: string | null | undefined): Uint8Array {
  const b = new Uint8Array(16);
  const s = (textIn ?? '').trim().toUpperCase();
  for (let i = 0; i < Math.min(16, s.length); i++) b[i] = s.charCodeAt(i) & 0x7f;
  return b;
}

/** A 6-character code (no 0, O, 1 or I). */
function newCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const r = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(r, (x) => alphabet[x % alphabet.length]).join('');
}

const bytesEq = (a: Uint8Array | null | undefined, b: Uint8Array | null | undefined): boolean => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);

class TourneyPanel implements PanelImpl {
  private readonly canvas: PerCanvas;
  private status!: PerText;
  private list!: HTMLElement;
  private busy = false;
  private alive = true;
  private refreshGen = 0;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly ctx: AppContext,
    private readonly per: PerRuntime,
    private readonly root: HTMLElement,
  ) {
    this.canvas = new PerCanvas(root, 'PerTourney');
    this.build(this.canvas.root);
    void this.refresh();
    // AutoRefresh: every 5 s while it's open.
    this.timer = setInterval(() => !this.busy && void this.refresh(), 5000);
  }

  private build(root: HTMLElement): void {
    box(root, 'Dim', PerColor.Dim, [0, 0], [1, 1]);
    const panel = box(root, 'Panel', PerColor.Panel, [0.14, 0.08], [0.86, 0.92]);
    const col = column(panel, 'Column', [0, 0], [1, 1]);
    text(col, '<b>Tournaments</b>  <size=60%>SOL tournaments on Solana (test network)</size>', 38);
    text(col, '2 to 30 players, 8-seat tables, 5,000 chips each round; blinds rise every level. 60% to 1st, 40% to 2nd (after a 5% platform fee on entries). Fees and prizes come from and go to your game balance.', 21).color = [1, 1, 1, 0.7];
    const top = line(col, 64, PerColor.Clear);
    button(top, 'Host a tournament', () => void this.ctx.router.push('private-tourney-host', { onDone: () => this.alive && void this.refresh() }), PerColor.Accent, 280);
    button(top, 'Enter code', () => void this.enterCode(), PerColor.Secondary, 200);
    button(top, 'Refresh', () => void this.refresh(), PerColor.Muted, 160);
    button(top, 'Close', () => closeScreen(this.ctx, this.root), PerColor.Muted, 160);
    this.status = text(col, '', 22);
    this.list = column(col, 'List', [0, 0], [1, 1], 8, 0);
  }

  private async fetch(all: boolean): Promise<Json[]> {
    const base = this.per.config.perBackendUrl;
    if (!base) noPerBackend();
    const r = await this.per.http.get(base + '/tournaments' + (all ? '?all=1' : ''));
    if (r.status !== 200) return [];
    const items = (JSON.parse(r.body) as { items?: Json[] }).items;
    return Array.isArray(items) ? items : [];
  }

  private async refresh(): Promise<void> {
    const gen = ++this.refreshGen;
    let items: Json[];
    try {
      items = await this.fetch(false);
    } catch (e) {
      if (this.alive && gen === this.refreshGen) this.setStatus(errMsg(e));
      return;
    }
    if (!this.alive || gen !== this.refreshGen) return;
    const me = w3(this.ctx).solana.address;
    clear(this.list);
    const now = Math.floor(Date.now() / 1000);
    const T = this.per.tourney;
    let shown = 0;
    for (const t of items) {
      const status = int(t.status);
      // Old finished ones stay out of the way; your own and running ones always show.
      const mine = me !== null && (str(t.host) === me || entrantOf(t, me) !== null);
      if (!mine && (status === T.PAID || status === T.CANCELLED) && now - num(t.startTs) > 3600) continue;
      this.row(t, me, now);
      shown++;
    }
    if (shown === 0) text(this.list, 'No tournaments yet. Host one!', 22);
    // Your round has started: say so, and let the player choose ("Go to your table" on that row).
    if (me !== null && !this.busy)
      for (const t of items) {
        const en = entrantOf(t, me);
        if (int(t.status) !== T.RUNNING || !en || int(en.state) !== T.ENTRANT_PLAYING || int(en.table) === T.NO_TABLE) continue;
        if (now < num(t.roundStartsTs)) continue;
        this.setStatus(`<color=#5ed39b>${str(t.name)}: your table is ready. Press "Go to your table" to play.</color>`);
        break;
      }
  }

  private row(t: Json, me: string | null, now: number): void {
    const T = this.per.tourney;
    const sol = this.per.format.sol;
    const address = new PublicKey(str(t.address));
    const status = int(t.status), count = int(t.count), max = int(t.maxPlayers);
    const fee = u64(t.entryFee), prize = u64(t.hostPrize);
    const { first, second } = T.payouts(fee, Math.max(count, 2), prize);
    const en = me ? entrantOf(t, me) : null;
    const host = me !== null && str(t.host) === me;
    const startTs = num(t.startTs);
    const roundStarts = num(t.roundStartsTs);
    const when = status === T.REGISTERING
      ? (startTs > now ? `starts in ${span(startTs - now)}` : count < 2 ? 'starting… (fewer than 2 players: it will be cancelled and refunded)' : 'starting… (preparing the tables)')
      : status === T.DRAWING ? 'drawing seats…'
      : status === T.RUNNING && now < roundStarts ? `round ${int(t.round)} starts in ${span(roundStarts - now)}`
      : status === T.RUNNING ? `round ${int(t.round)} · level ${1 + Math.floor((now - num(t.runningSince)) / Number(T.levelSeconds(int(t.speed))))}`
      : status === T.CANCELLED ? 'cancelled (refunded)' : 'finished';
    const l = line(this.list, 74, PerColor.Row);
    const you = !en ? '' : int(en.state) === T.ENTRANT_OUT ? ` · <color=#e0c27e>you finished ${ordinal(int(en.place))}</color>` : ' · <color=#5ed39b>registered</color>';
    text(l, `<b>${str(t.name)}</b>${t.private === true ? ' (private)' : ''} · ${when} · ${count}/${max} · entry ${sol(fee)} · 1st ${sol(first)}, 2nd ${sol(second)}${you}`, 22, 'Left', 3);
    if (status === T.REGISTERING) {
      if (!en && count < max) button(l, `Register  ${sol(fee)}`, () => void this.registerAsk(address, t.private === true), PerColor.Secondary, 260);
      if (en) button(l, 'Leave', () => void this.money('Leaving (your fee comes back)…', (k) => T.leave(address, k)[1]!), PerColor.Muted, 140);
      if (host) button(l, 'Cancel', () => void this.money('Cancelling (everyone is refunded)…', (k) => T.cancel(address, k)[1]!), PerColor.Warn, 150);
    } else if (status === T.RUNNING && en && int(en.state) === T.ENTRANT_PLAYING) {
      const table = int(en.table);
      if (table !== T.NO_TABLE) button(l, 'Go to your table', () => void this.goToTable(address, table), PerColor.Accent, 260);
    }
  }

  private async goToTable(address: PublicKey, table: number): Promise<void> {
    try {
      const params = await this.per.joinTourney(address, table, (s) => this.setStatus(s));
      if (params) await this.ctx.router.navigate('table', params);
    } catch (e) {
      this.setStatus("Couldn't open your table: " + errMsg(e));
      console.error(e);
    }
  }

  private async registerAsk(tourney: PublicKey, isPrivate: boolean): Promise<void> {
    let code: Uint8Array | null = null;
    if (isPrivate) {
      const input = await ask('This tournament is private. Enter its code:', '');
      if (!input || input === '\u0001') return;
      code = codeBytes(input);
    }
    await this.register(tourney, code);
  }

  private async register(tourney: PublicKey, code: Uint8Array | null): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const st = (s: string) => this.setStatus(s);
    try {
      if (!(await w3(this.ctx).solana.connect())) return this.setStatus('Connect a wallet first.');
      const key = await this.per.gameWallet.playKey(st);
      // The table key for this tournament: signs your seeds and actions, reads your cards.
      const reader = await PerSessionKeys.forKey(this.per.gameWallet.address!, tourney);
      st('Registering (the entry fee comes from your game balance; no wallet prompt)…');
      await this.per.gameWallet.sendAsKey(key, this.per.tourney.register(tourney, key, reader.publicKey, code)[1]!);
      st('Registered. Come back at the start time; the game takes you to your table.');
    } catch (e) {
      this.setStatus("Couldn't register: " + errMsg(e));
      console.error(e);
    } finally {
      this.busy = false;
      await this.refresh();
    }
  }

  private async money(doing: string, ix: (k: PlayKey) => TransactionInstruction): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const key = await this.per.gameWallet.playKey((s) => this.setStatus(s));
      this.setStatus(doing);
      await this.per.gameWallet.sendAsKey(key, ix(key));
      this.setStatus('Done.');
    } catch (e) {
      this.setStatus("Couldn't do that: " + errMsg(e));
      console.error(e);
    } finally {
      this.busy = false;
      await this.refresh();
    }
  }

  /** A private tournament's code, tried against every private tournament (its hash is public). */
  private async enterCode(): Promise<void> {
    const input = await ask('Tournament code:', '');
    if (!input || input === '\u0001') return;
    const code = codeBytes(input);
    const T = this.per.tourney;
    try {
      const rpc = new PerRpc(this.per.http, this.per.config.teeUrl);
      for (const t of await this.fetch(true)) {
        if (t.private !== true || int(t.status) !== T.REGISTERING) continue;
        const address = new PublicKey(str(t.address));
        const onChain = T.decode(await rpc.getAccount(address));
        if (onChain && bytesEq(onChain.codeHash, T.codeHash(address, code))) return void (await this.register(address, code));
      }
      this.setStatus('No open tournament has that code.');
    } catch (e) {
      this.setStatus(errMsg(e));
    }
  }

  private setStatus(s: string): void {
    if (this.alive) this.status.text = s;
    logStatus('PerTourney', s);
  }

  unmount(): void {
    this.alive = false;
    clearInterval(this.timer);
    this.canvas.dispose();
  }
}

function entrantOf(t: Json, wallet: string): Json | null {
  const list = Array.isArray(t.entrants) ? (t.entrants as Json[]) : [];
  return list.find((e) => str(e.wallet) === wallet) ?? null;
}

// ---------------------------------------------------------------- PerTourneyHostPanel

const PLAYERS = [8, 16, 24, 30];
const FEES = [0n, 1_000_000n, 5_000_000n, 10_000_000n];
const PRIZES = [0n, 5_000_000n, 10_000_000n];
const START_MINUTES = [10, 30, 60];

export interface TourneyHostParams {
  onDone?: () => void;
}

class TourneyHostPanel implements PanelImpl {
  private readonly canvas: PerCanvas;
  private speed: number;
  private players = 0;
  private fee = 2;
  private prize = 0;
  private start = 0;
  private isPrivate = false;
  private busy = false;
  private alive = true;
  private name = 'Nomad freezeout';
  private status!: PerText;
  private nameText!: PerText;
  private readonly groups: PerButton[][] = [];
  private privateButton!: PerButton;

  constructor(
    private readonly ctx: AppContext,
    private readonly per: PerRuntime,
    private readonly root: HTMLElement,
    private readonly params: TourneyHostParams,
  ) {
    this.speed = per.tourney.TURBO;
    this.canvas = new PerCanvas(root, 'PerTourneyHost');
    this.build(this.canvas.root);
  }

  private build(root: HTMLElement): void {
    const sol = this.per.format.sol;
    box(root, 'Dim', PerColor.Dim, [0, 0], [1, 1]);
    const panel = box(root, 'Panel', PerColor.Panel, [0.22, 0.08], [0.78, 0.92]);
    const col = column(panel, 'Column', [0, 0], [1, 1]);
    text(col, '<b>Host a tournament</b>', 36);
    text(col, 'One wallet approval creates it (about 0.03 SOL of rent). Your prize comes from your game balance and can only go up. The game pays for the tables. If fewer than 2 players register, everyone is refunded.', 20).color = [1, 1, 1, 0.7];
    const nameRow = line(col, 60, PerColor.Clear);
    this.nameText = text(nameRow, '', 24, 'Left', 2);
    button(nameRow, 'Name…', async () => {
      const s = await ask('Tournament name (1 to 40 characters):', this.name);
      if (s && s !== '\u0001') this.name = s.length > 40 ? s.slice(0, 40) : s;
      this.paint();
    }, PerColor.Muted, 160);
    this.group(col, 'Speed', [...this.per.tourney.SPEED_LABELS], (i) => (this.speed = i), 260);
    this.group(col, 'Players (most)', PLAYERS.map(String), (i) => (this.players = i), 110);
    this.group(col, 'Entry fee', FEES.map((f) => (f === 0n ? 'Free' : sol(f))), (i) => (this.fee = i), 190);
    this.group(col, 'Your prize', PRIZES.map((f) => (f === 0n ? 'None' : sol(f))), (i) => (this.prize = i), 190);
    this.group(col, 'Starts in', START_MINUTES.map((m) => (m < 60 ? `${m} min` : `${m / 60} h`)), (i) => (this.start = i), 140);
    const priv = line(col, 60, PerColor.Clear);
    this.privateButton = button(priv, 'Private (code)', () => ((this.isPrivate = !this.isPrivate), this.paint()), PerColor.Muted, 240);
    text(priv, "Private ones aren't listed; players join with a 6-character code.", 20);
    this.status = text(col, '', 22);
    const bottom = line(col, 64, PerColor.Clear);
    text(bottom, '', 20);
    button(bottom, 'Cancel', () => this.close(), PerColor.Muted, 180);
    button(bottom, 'Create tournament', () => void this.create(), PerColor.Accent, 280);
    this.paint();
  }

  private group(col: HTMLElement, title: string, labels: string[], pick: (i: number) => void, width: number): void {
    text(col, title, 22);
    const row = line(col, 56, PerColor.Clear);
    this.groups.push(labels.map((l, k) => button(row, l, () => (pick(k), this.paint()), PerColor.Muted, width)));
  }

  private paint(): void {
    const picked = [this.speed, this.players, this.fee, this.prize, this.start];
    this.groups.forEach((g, gi) => g.forEach((b, i) => (b.color = i === picked[gi] ? PerColor.Selected : PerColor.Muted)));
    this.privateButton.color = this.isPrivate ? PerColor.Selected : PerColor.Muted;
    this.nameText.text = 'Name: ' + this.name;
  }

  private async create(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const per = this.per;
    const T = per.tourney;
    const sol = per.format.sol;
    const st = (s: string) => this.setStatus(s);
    try {
      if (!(await w3(this.ctx).solana.connect())) return this.setStatus('Connect a wallet first.');
      const wallet = per.gameWallet.address!;
      await per.gameWallet.ensureVault(st, 'no tournament was created');
      const key = await per.gameWallet.playKey(st);
      const prize = PRIZES[this.prize]!;
      if (prize > 0n) {
        const balance = (await per.balance(st)) ?? 0n;
        if (balance < prize) return this.setStatus(`Your game balance is ${sol(balance)}; the prize is ${sol(prize)}. Deposit first.`);
      }
      const id = per.host.newTableId();
      const address = T.address(wallet, id);
      const code = this.isPrivate ? newCode() : null;
      const p: TourneyParams = {
        name: T.nameBytes(this.name), speed: this.speed, maxPlayers: PLAYERS[this.players]!, entryFee: FEES[this.fee]!,
        startTs: BigInt(Math.floor(Date.now() / 1000) + START_MINUTES[this.start]! * 60 + 30),
        codeHash: code ? T.codeHash(address, codeBytes(code)) : new Uint8Array(32),
      };
      st('Approve creating the tournament in your wallet…');
      await per.gameWallet.l1.sendWithWallet(T.createAndDelegate(wallet, id, p), per.gameWallet.signer);
      if (prize > 0n) {
        st(`Putting in your ${sol(prize)} prize from your game balance (no wallet prompt)…`);
        let last: unknown = null;
        for (let i = 0; i < 10; i++) {
          await per.http.delay(3000); // the rollup picks up the handed-over tournament within seconds
          try {
            await per.gameWallet.sendAsKey(key, T.fund(address, key, prize)[1]!);
            last = null;
            break;
          } catch (e) {
            last = e;
          }
        }
        if (last) throw new Error("the tournament was created but the prize couldn't be added yet (" + errMsg(last) + ')');
      }
      if (code) {
        copyText(code);
        st(`Tournament created. Its code is <b>${code}</b> (copied): send it to the players you want.`);
        await per.http.delay(6000);
      } else st('Tournament created. It appears in the list within a few seconds.');
      await per.http.delay(1500);
      this.close();
    } catch (e) {
      this.setStatus("Couldn't host: " + errMsg(e));
      console.error(e);
    } finally {
      this.busy = false;
    }
  }

  private setStatus(s: string): void {
    if (this.alive) this.status.text = s;
    logStatus('PerTourneyHost', s);
  }

  private close(): void {
    if (!this.alive) return;
    this.params.onDone?.();
    closeScreen(this.ctx, this.root);
  }

  unmount(): void {
    this.alive = false;
    this.canvas.dispose();
  }
}

export const tourneyPanel: PanelFactory<Record<string, never>> = (ctx, per, root) => new TourneyPanel(ctx, per, root);
export const tourneyHostPanel: PanelFactory<TourneyHostParams> = (ctx, per, root, params) => new TourneyHostPanel(ctx, per, root, params);
