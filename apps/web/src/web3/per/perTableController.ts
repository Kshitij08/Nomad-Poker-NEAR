/**
 * Drives the usual table screen (TableView + TableEventPresenter + betting panel) from a private table in the TEE
 * rollup, the way the offline controller drives it from the engine. Port of Per/Unity/PerTableController.cs as a
 * TableSessionFactory: `router.navigate('table', perTableParams(...))`. Leaving goes through TableSession.requestLeave.
 *
 *  - Loop (every 0.6 s): poll the rollup, re-login when the token expires, keep the table moving (keeper fallback),
 *    sit back in after a missed seed window, Start round (host), the between-hands countdown, prepare the next hand.
 *  - Pump: plays the session's PokerEvents through the presenter with the C# pacing (DealDelay 0.12, settle 0.9,
 *    action 0.4, showdown 2.0) on the shared ticker, and prompts the betting panel on our turn.
 *  - HUD (PerTableController.BuildHud): the status strip (without Unity's TEE badge), Verify hand, Start round.
 *  - Leave (RequestLeave + Leave): waits for the table to be idle, then cashes the seat out to the game balance (the
 *    table key signs; fallbacks as in the C#), forgets the table key and returns to the menu.
 *
 * Tournament tables (M11 TourneyLoop) are recognised (no cash-out, "Back to lobby") but the tourney loop itself —
 * seating rounds, syncing, moving tables — is not driven here yet (see the module report).
 */
import {
  ActionType, BettingRound, Card, PokerSound, TableEventPresenter, TableMoney, type BettingPanelPort, type PokerEvent,
  type SeatRole, type TableRosterEvent, type TableViewPort, type TurnStartedEvent,
} from '@nomad/engine';
import type { TableScreenParams, TableSession, TableSessionHost } from '../../table/tableScreen';
import { tickerWait } from '../../table/tableView';
import type { Web3Config } from '../config';
import { bytesEq } from '../lib/bytes';
import type { PerHttp } from '../lib/http';
import type { PerEntry, PerSeat } from './entry';
import { PerIx } from './ix';
import { PerSessionKeys } from './keys';
import { PerGame } from './legal';
import { sol } from './money';
import { LocalSigner, PerUnauthorized, TeeAuth } from './rpc';
import { PerTableSession } from './tableSession';
import { decode } from './types';
import { PerVault } from './vault';
import { verify, verifyLog } from './verifier';
import { NomadPerTableHud, type PerHud } from '../nomad/perTableHud';

const POLL_SECONDS = 0.6;
const PREPARE_EVERY_SECONDS = 3;
const BETWEEN_HANDS_SECONDS = 8;
const DEAL_DELAY = 0.12;
const DEAL_SETTLE_DELAY = 0.9;
const ACTION_DELAY = 0.4;
const SHOWDOWN_DELAY = 2.0;

export interface PerTableDeps {
  config: Web3Config;
  http: PerHttp;
  entry: PerEntry;
}

/** Live controllers by table visit (the menu's leave dialog asks whether it's a tournament table). */
export const perControllers = new WeakMap<TableSessionHost, PerTableController>();

/** Params for router.navigate('table', …): the PER session (its requestLeave cashes the seat out before the table closes). */
export function perTableParams(deps: PerTableDeps, seat: PerSeat): TableScreenParams {
  return { session: (host) => new PerTableController(deps, seat, host) };
}

const realWait = (s: number) => new Promise<void>((r) => setTimeout(r, s * 1000));

/**
 * TableView.SetLocalPerspective (Game/Views/TableView.cs) over the table screen's view: chain seat `s` is drawn in slot
 * ((localSlot + s − localSeat) mod n), n = the view's seat count (8 seat HUDs, as Unity's Initialize(8)), so the player
 * sits in the scene's "you" seat (slot 0: PokerClientGame.localPerspectiveSeat = Name_Canvas_Player). Seats ≥ n have
 * no view (Unity's _seatToSlot covers 0..n−1 only).
 */
export class RotatedView implements TableViewPort {
  /** The local seat (−1 = identity, before the session knows it). */
  offset = -1;
  readonly localSlot = 0;
  constructor(private readonly inner: TableViewPort) {}
  get seatCount(): number {
    return this.inner.seatCount;
  }
  get betting(): BettingPanelPort | null {
    return this.inner.betting;
  }
  slot(seat: number): number {
    const n = this.inner.seatCount;
    if (this.offset < 0) return seat;
    return (((this.localSlot + (seat - this.offset)) % n) + n) % n;
  }
  private ok(seat: number): boolean {
    return seat >= 0 && seat < this.inner.seatCount;
  }
  bindSeat(seat: number, name: string, stack: number, isBot: boolean, avatar: number, avatarName: string | null) {
    if (this.ok(seat)) this.inner.bindSeat(this.slot(seat), name, stack, isBot, avatar, avatarName);
  }
  hideSeat(seat: number) {
    if (this.ok(seat)) this.inner.hideSeat(this.slot(seat));
  }
  beginHand(n: number) {
    this.inner.beginHand(n);
  }
  resetSeatForHand(seat: number, stack: number, role: SeatRole, busted: boolean) {
    if (this.ok(seat)) this.inner.resetSeatForHand(this.slot(seat), stack, role, busted);
  }
  showBlind(seat: number, stackAfter: number, bet: number, pot: number) {
    if (this.ok(seat)) this.inner.showBlind(this.slot(seat), stackAfter, bet, pot);
  }
  showHoleCards(seat: number, c0: Card, c1: Card, faceUp: boolean) {
    if (this.ok(seat)) this.inner.showHoleCards(this.slot(seat), c0, c1, faceUp);
  }
  showBoard(newCards: Card[], board: Card[]) {
    this.inner.showBoard(newCards, board);
  }
  showAction(seat: number, stackAfter: number, bet: number, d: string, pot: number, folded: boolean) {
    if (this.ok(seat)) this.inner.showAction(this.slot(seat), stackAfter, bet, d, pot, folded);
  }
  showShowdown(seat: number, c0: Card, c1: Card, d: string) {
    if (this.ok(seat)) this.inner.showShowdown(this.slot(seat), c0, c1, d);
  }
  showPotAward(seat: number, stackAfter: number, message: string, pot: number) {
    if (this.ok(seat)) this.inner.showPotAward(this.slot(seat), stackAfter, message, pot);
  }
  endHand() {
    this.inner.endHand();
  }
  showMessage(m: string) {
    this.inner.showMessage(m);
  }
  showGameOver(m: string) {
    this.inner.showGameOver(m);
  }
  setTurn(seat: number, timer: number, elapsed?: number) {
    if (this.ok(seat)) this.inner.setTurn(this.slot(seat), timer, elapsed);
  }
  clearTurn(seat: number) {
    if (this.ok(seat)) this.inner.clearTurn(this.slot(seat));
  }
  showReaction(seat: number, id: number) {
    if (this.ok(seat)) this.inner.showReaction?.(this.slot(seat), id);
  }
  setVoiceState(seat: number, talking: boolean, muted: boolean) {
    if (this.ok(seat)) this.inner.setVoiceState?.(this.slot(seat), talking, muted);
  }
}

export class PerTableController implements TableSession {
  readonly session: PerTableSession;
  private readonly view: RotatedView;
  private readonly presenter: TableEventPresenter;
  private readonly events: PokerEvent[] = [];
  private stopped = false;
  private leaving = false;
  private wantLeave = false;
  private wantStart = false;
  private perspectiveSet = false;
  private myCurrentBet = 0;
  private lastPrepare = -100;
  private sitInAt = -100;
  private idleHand = -1n;
  private idleSince = 0;
  private countdownShown = -1;
  private shownWait: string | null = null;
  private promptAbort: AbortController | null = null;
  private hud: PerHud | null = null;
  private wake: (() => void) | null = null;

  constructor(
    private readonly deps: PerTableDeps,
    readonly seat: PerSeat,
    private readonly host: TableSessionHost,
  ) {
    this.session = new PerTableSession(seat.table, seat.publicRpc, seat.sessionRpc, new LocalSigner(seat.sessionKey), seat.wallet);
    this.session.onEvent((e) => {
      this.events.push(e);
      this.wake?.();
    });
    this.view = new RotatedView(host.view);
    this.presenter = new TableEventPresenter(this.view, seat.seatIndex, host.audio);
    perControllers.set(host, this);
  }

  get isTournament(): boolean {
    return this.seat.tourney !== null;
  }

  private now(): number {
    return performance.now() / 1000;
  }

  start(): void {
    // Stacks, bets and the pot are lamports here: the table writes them as dollars.
    TableMoney.custom = (v) => sol(BigInt(Math.max(0, Math.trunc(v))));
    this.view.showMessage(this.isTournament ? 'Tournament · waiting for the round to start…' : 'Private table · waiting for players…');
    const handlers = {
      onVerify: () => this.verifyText(),
      onStart: () => (this.wantStart = true),
      onBackToLobby: this.isTournament ? () => this.host.leave() : null,
    };
    // The Nomad look when the menu is installed (NomadDialogs pieces, as Unity builds it); else a plain DOM HUD.
    const nomad = this.host.ctx.services.nomad;
    const layer = document.querySelector<HTMLElement>('[data-screen="table"]');
    this.hud = nomad && layer ? new NomadPerTableHud(nomad, layer, handlers) : new PerTableHud(this.host, handlers);
    void this.loop();
    void this.pump();
  }

  stop(): void {
    this.stopped = true;
    this.cancelPrompt();
    this.wake?.();
    this.cleanup();
  }

  private cleanup(): void {
    TableMoney.custom = null;
    this.hud?.dispose();
    this.hud = null;
    if (this.deps.entry.current === this.seat) this.deps.entry.left();
  }

  private status(s: string): void {
    this.hud?.setStatus(s);
  }

  // ---- polling and the seat's routine transactions

  private async loop(): Promise<void> {
    while (!this.stopped) {
      let pollError: unknown = null;
      try {
        await this.session.poll();
      } catch (e) {
        pollError = e;
      }
      if (this.stopped) break;
      if (pollError instanceof PerUnauthorized) {
        // The rollup login expired: log in again with the session key (no wallet prompt).
        this.status('Reconnecting to the private rollup…');
        await this.relogin().catch((e) => this.status('Connection: ' + (e as Error).message));
        continue;
      }
      if (pollError) this.status('Connection: ' + ((pollError as Error).message ?? pollError));
      else await this.session.keepMoving().catch(() => null);
      if (!this.perspectiveSet && this.session.mySeat >= 0) {
        this.perspectiveSet = true;
        this.presenter.localSeat = this.session.mySeat;
        this.view.offset = this.session.mySeat;
      }
      const t = this.session.table;
      if (this.wantLeave && t && t.handState === PerGame.HandIdle) {
        await this.leave();
        if (this.leaveDone === null) break; // cashed out: the table screen takes it from here
        await realWait(POLL_SECONDS);
        continue;
      }
      const mine = this.session.mySeat >= 0 && this.session.ledger ? this.session.ledger.seats[this.session.mySeat] : null;
      if (!this.wantLeave && mine?.sittingOut && this.now() - this.sitInAt > 5) {
        this.sitInAt = this.now();
        await this.session.sitIn().catch((e) => console.warn('[PerTable] sit in:', (e as Error).message));
      }
      const idleSeated = !this.wantLeave && !!t && t.handState === PerGame.HandIdle && t.status === PerGame.StatusOpen && this.session.mySeat >= 0;
      const canStart = idleSeated && !this.session.startRequested && this.session.mayStartRound && this.session.seatedWithChips >= 2;
      this.hud?.showStart(canStart && !this.isTournament);
      if (this.wantStart) {
        this.wantStart = false;
        if (canStart) {
          this.status('Starting the round…');
          this.lastPrepare = this.now();
          await this.session.requestStart().catch((e) => this.status("Couldn't start the round: " + (e as Error).message));
        }
      }
      if (idleSeated && !this.session.startRequested) {
        const wait = this.session.seatedWithChips < 2 ? 'Waiting for another player to sit down · LEAVE to cash out'
          : this.session.mayStartRound ? "Press Start round when everyone's ready · LEAVE to cash out"
            : 'Waiting for the host to start the next round · LEAVE to cash out';
        if (wait !== this.shownWait) {
          this.shownWait = wait;
          this.status(wait);
        }
      } else this.shownWait = null;
      if (t && t.handState === PerGame.HandIdle && this.idleHand !== t.handNo) {
        this.idleHand = t.handNo;
        this.idleSince = this.now();
        this.countdownShown = -1;
      }
      const between = idleSeated && this.session.startRequested && !this.session.firstRoundNext;
      const paused = between && this.now() - this.idleSince < BETWEEN_HANDS_SECONDS;
      if (between) {
        const left = Math.max(0, Math.ceil(BETWEEN_HANDS_SECONDS - (this.now() - this.idleSince)));
        if (left !== this.countdownShown) {
          this.countdownShown = left;
          this.status(this.isTournament ? (left > 0 ? `Next hand in ${left} s` : 'Starting the next hand…')
            : left > 0 ? `Next hand in ${left} s · press LEAVE to cash out and leave` : 'Starting the next hand (waiting for every player) · LEAVE to cash out');
        }
      }
      if (idleSeated && this.session.startRequested && !paused && this.now() - this.lastPrepare > PREPARE_EVERY_SECONDS) {
        this.lastPrepare = this.now();
        await this.session.prepareNextHand().catch((e) => this.status((e as Error).message));
      }
      await realWait(POLL_SECONDS);
    }
  }

  private async pump(): Promise<void> {
    while (!this.stopped) {
      const e = this.events.shift();
      if (!e) {
        await new Promise<void>((r) => (this.wake = r));
        this.wake = null;
        continue;
      }
      switch (e.type) {
        case 'TableRoster': this.status(rosterText(e)); break;
        case 'HandStarted':
          this.cancelPrompt();
          this.myCurrentBet = 0;
          this.presenter.onHandStarted(e);
          this.status(this.wantLeave ? 'Cashing out after this hand…' : `Hand ${e.handNumber}`);
          break;
        case 'BlindPosted':
          this.presenter.onBlindPosted(e);
          if (e.seat === this.session.mySeat) this.myCurrentBet = e.amount;
          await tickerWait(DEAL_DELAY);
          break;
        case 'HoleCardsDealt': this.presenter.onHoleCardsDealt(e); await tickerWait(DEAL_DELAY); break;
        case 'BettingRoundChanged':
          this.myCurrentBet = 0;
          this.presenter.onRoundChanged(e);
          if (e.round === BettingRound.Preflop) await tickerWait(DEAL_SETTLE_DELAY);
          break;
        case 'CommunityDealt': this.presenter.onCommunityDealt(e); await tickerWait(DEAL_SETTLE_DELAY); break;
        case 'TurnStarted': this.onTurn(e); break;
        case 'PlayerActed':
          if (e.seat === this.session.mySeat) this.myCurrentBet = e.amount;
          this.view.clearTurn(e.seat);
          this.presenter.onPlayerActed(e);
          if (e.seat === this.session.mySeat && e.action === ActionType.Fold && !this.wantLeave) this.status('You folded · press LEAVE to cash out after this hand');
          await tickerWait(ACTION_DELAY);
          break;
        case 'Showdown': this.presenter.onShowdown(e); await tickerWait(SHOWDOWN_DELAY); break;
        case 'PotAwarded': this.presenter.onPotAwarded(e); await tickerWait(SHOWDOWN_DELAY); break;
        case 'HandEnded':
          this.cancelPrompt();
          this.presenter.onHandEnded(e);
          this.status(this.wantLeave ? 'Cashing out…' : `Hand ${e.handNumber} over · press Verify to check it`);
          break;
        default: break;
      }
    }
  }

  private onTurn(e: TurnStartedEvent): void {
    this.cancelPrompt();
    this.view.setTurn(e.seat, e.turnSeconds, 0);
    if (!e.forYou) return;
    this.host.audio.play(PokerSound.YourTurn);
    const panel = this.view.betting;
    if (!panel) return;
    const abort = (this.promptAbort = new AbortController());
    panel.show(e.legal, this.myCurrentBet, (a) => {
      if (abort.signal.aborted) return;
      panel.hide();
      this.promptAbort = null;
      // A failed send (network, or the turn just ran out) shows the prompt again while it's still ours.
      this.session.act(a.type, a.amount).catch((err) => {
        this.status('Action refused: ' + ((err as Error).message ?? err));
        this.session.repromptTurn();
      });
    });
  }

  private cancelPrompt(): void {
    this.promptAbort?.abort();
    this.promptAbort = null;
    this.view.betting?.hide();
  }

  private async relogin(): Promise<void> {
    const token = await TeeAuth.login(this.deps.http, this.deps.config.teeUrl, new LocalSigner(this.seat.sessionKey));
    this.seat.sessionRpc.setUrl(`${this.deps.config.teeUrl}?token=${token}`);
  }

  // ---- verify

  /** The Verify panel's text (PerTableController.ToggleVerify), as plain lines with OK / FAIL marks. */
  verifyText(): string {
    const s = this.session;
    const rec = s.lastRecord;
    if (!rec) return 'No finished hand yet. Play one, then verify it.';
    const v = verify(rec, s.lastPrevButton, s.mySeat, s.lastMySeed, s.lastMyCards);
    const mark = (ok: boolean) => (ok ? 'OK' : 'FAIL');
    const lines = [`Hand ${rec.handNo}, recomputed in your client from its public record:`];
    lines.push(`${mark(v.ok)} deck = shuffle(published entropy + every dealt seat's seed)`);
    lines.push(`${mark(v.ok)} button seat ${rec.button}` + (s.lastPrevButton != null || rec.handNo === 1n ? ' (rotation checked)' : ''));
    if (s.lastMyCards) lines.push(`${mark(v.ok)} the two cards you were dealt came from this deck`);
    if (s.lastMySeed) lines.push(`${mark(v.ok)} your own seed went into the shuffle`);
    for (const n of v.notes) lines.push('• ' + n);
    for (const p of v.problems) lines.push('FAIL ' + p);
    if (s.lastLog) {
      const l = verifyLog(rec, s.lastLog);
      lines.push(`${mark(l.ok)} the ${s.lastLog.len} actions you saw hash to the record's log hash`);
      for (const p of l.problems) lines.push('FAIL ' + p);
    }
    lines.push('', 'Deck: ' + v.deck.map((c) => Card.fromIndex(c).short).join(' '));
    lines.push(`Table ${this.seat.table.toBase58()}. The same record is on Solana after the table's next commit.`);
    return lines.join('\n');
  }

  // ---- leave

  private leaveDone: (() => void) | null = null;

  /**
   * TableSession.requestLeave (PerTableController.RequestLeave): stop starting hands; the poll loop cashes the seat out
   * as soon as the table is idle (one loop only, as in the C#) and this resolves once it has. A failed cash-out keeps
   * the player at the table with the reason in the status line and is tried again on the next idle poll. A tournament
   * seat isn't cashed out: its chips stay in play (Back to lobby).
   */
  requestLeave(): Promise<void> {
    if (this.isTournament || this.stopped) return Promise.resolve();
    this.wantLeave = true;
    const t = this.session.table;
    this.status(t && this.session.mySeat >= 0 && t.handState !== PerGame.HandIdle && t.dealtMask & (1 << this.session.mySeat)
      ? 'Cashing out after this hand (fold to leave sooner)…' : 'Cashing out…');
    return new Promise<void>((resolve) => {
      const prev = this.leaveDone;
      this.leaveDone = () => {
        prev?.();
        resolve();
      };
    });
  }

  /** PerTableController.Leave, run by the loop when the table is idle. */
  private async leave(): Promise<void> {
    if (this.leaving) return;
    this.leaving = true;
    this.cancelPrompt();
    try {
      if (await this.cashOut()) {
        const done = this.leaveDone;
        this.leaveDone = null;
        done?.();
      }
    } finally {
      this.leaving = false;
    }
  }

  /** PerTableController.Leave: true once the seat is cashed out (or there's none). */
  private async cashOut(): Promise<boolean> {
    const { entry } = this.deps;
    const gw = entry.gameWallet;
    let seat = this.session.mySeat;
    // Review #7: forget the table key only when a fresh read shows no seat holds it.
    let forget = seat >= 0;
    if (seat < 0) {
      try {
        const fresh = decode.ledger(await this.seat.sessionRpc.getAccount(this.session.addresses.ledger));
        forget = fresh !== null;
        if (fresh)
          for (let i = 0; i < fresh.seats.length; i++)
            if (bytesEq(fresh.seats[i]!.reader, this.seat.sessionKey.publicKey.toBytes()) && bytesEq(fresh.seats[i]!.player, this.seat.wallet.toBytes())) seat = i;
      } catch (e) {
        console.warn('[PerTable] ledger before leaving:', (e as Error).message);
      }
    }
    try {
      if (seat >= 0) {
        // M9: the stack goes to the game balance and the table key signs (no wallet transaction).
        let open = await gw.vaultOpen();
        if (!open) {
          this.status('Approve opening your game balance in your wallet (one time; about 0.013 SOL of account rent)…');
          await gw.l1.sendWithWallet([PerVault.openVaultBudget(), PerVault.openVault(this.seat.wallet)], gw.signer).catch((e) => console.warn('[Per] open_vault:', (e as Error).message));
          open = await gw.vaultOpen().catch(() => false);
        }
        if (!open) {
          this.status("Your game balance can't be used; approve the cash-out to your wallet instead (your wallet can't preview it)…");
          await this.seat.sessionRpc.sendWithWallet([PerIx.cashOut(this.session.addresses, this.seat.wallet, seat)], gw.signer);
        } else {
          this.status('Cashing out to your game balance…');
          await this.seat.sessionRpc.send([PerVault.cashOut(this.session.addresses, this.seat.sessionKey.publicKey, this.seat.wallet, seat, 0n)], new LocalSigner(this.seat.sessionKey));
        }
      }
    } catch (e) {
      this.status('Cash-out failed: ' + ((e as Error).message ?? e));
      return false;
    }
    if (forget) PerSessionKeys.forget(this.seat.wallet, this.seat.table);
    return true;
  }
}

function rosterText(e: TableRosterEvent): string {
  const n = e.seats.filter((s) => s?.isOccupied).length;
  return n < 2 ? 'Waiting for another player…' : `${n} players seated · next hand starts when everyone's seed is in`;
}

// ------------------------------------------------------------------------------ HUD

/**
 * PerTableController.BuildHud in DOM: the slim status strip at the top centre (anchors 0.24–0.76 × 0.86–0.935 of the
 * 1920×1080 reference, colour (0.03, 0.05, 0.18, 0.82), rounded) with the status (Unity's TEE badge left out); Verify hand and
 * Start round pinned to the top-right corner at (−150, −250) / (−150, −345); the Verify panel at anchors
 * 0.55–0.98 × 0.12–0.78 in PerUi.Panel. The second wave reskins the buttons with the menu's NomadDialogs pieces.
 */
class PerTableHud implements PerHud {
  private readonly root = document.createElement('div');
  private readonly statusEl = document.createElement('span');
  private readonly startBtn: HTMLButtonElement;
  private readonly verifyPanel = document.createElement('div');

  constructor(host: TableSessionHost, private readonly h: { onVerify: () => string; onStart: () => void; onBackToLobby: (() => void) | null }) {
    this.root.className = 'per-hud';
    const strip = div('per-hud-strip');
    this.statusEl.className = 'per-hud-status';
    strip.append(this.statusEl);
    const verify = button('Verify hand', 'per-hud-btn per-hud-verify', () => this.toggleVerify());
    this.startBtn = button('Start round', 'per-hud-btn per-hud-start', () => h.onStart());
    this.startBtn.hidden = true;
    this.verifyPanel.className = 'per-hud-verify-panel';
    this.verifyPanel.hidden = true;
    this.root.append(strip, verify, this.startBtn, this.verifyPanel);
    if (h.onBackToLobby) this.root.append(button('Back to lobby', 'per-hud-btn per-hud-back', h.onBackToLobby));
    injectStyle();
    const layer = document.querySelector(`[data-screen="table"]`) ?? document.body;
    layer.append(this.root);
    void host;
  }

  setStatus(s: string): void {
    this.statusEl.textContent = s;
  }

  showStart(on: boolean): void {
    if (this.startBtn.hidden === on) this.startBtn.hidden = !on;
  }

  private toggleVerify(): void {
    this.verifyPanel.hidden = !this.verifyPanel.hidden;
    if (this.verifyPanel.hidden) return;
    this.verifyPanel.replaceChildren();
    for (const line of this.h.onVerify().split('\n')) {
      const p = document.createElement('div');
      p.textContent = line;
      if (line.startsWith('OK')) p.className = 'ok';
      if (line.startsWith('FAIL')) p.className = 'bad';
      this.verifyPanel.append(p);
    }
  }

  dispose(): void {
    this.root.remove();
  }
}

const div = (cls: string) => Object.assign(document.createElement('div'), { className: cls });
function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

let styled = false;
function injectStyle(): void {
  if (styled) return;
  styled = true;
  const s = document.createElement('style');
  s.textContent = `
.per-hud{position:absolute;inset:0;pointer-events:none;z-index:40;font-family:inherit;container-type:size}
.per-hud>*{pointer-events:auto}
.per-hud-strip{position:absolute;left:24%;right:24%;top:6.5%;height:7.5%;background:rgba(8,13,46,.82);border-radius:1.2cqh;display:flex;align-items:center;gap:1.2cqw;padding:0 0.85cqw;color:#fff;font-size:min(2cqh,1.15cqw);overflow:hidden}
.per-hud-status{flex:1;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.per-hud-btn{position:absolute;right:calc(150/1920*100cqw - 125/1920*100cqw);width:calc(250/1920*100cqw);height:calc(80/1080*100cqh);border:0;border-radius:1cqh;font:inherit;font-weight:700;font-size:min(2.2cqh,1.3cqw);cursor:pointer}
.per-hud-verify{top:calc(210/1080*100cqh);background:#2b6fd6;color:#fff}
.per-hud-start{top:calc(305/1080*100cqh);background:#f5c542;color:#1b1b1b}
.per-hud-back{top:calc(400/1080*100cqh);background:#2b6fd6;color:#fff}
.per-hud-verify-panel{position:absolute;left:55%;right:2%;top:22%;bottom:12%;background:rgba(18,23,31,.96);color:#fff;padding:20px;overflow:auto;font-size:min(1.9cqh,1.1cqw);line-height:1.35;white-space:pre-wrap}
.per-hud-verify-panel .ok{color:#5ed39b}.per-hud-verify-panel .bad{color:#e0915f}
`;
  document.head.append(s);
}

/** For the menu's leave dialog (tableLeaveHooks.isTournament). */
export function isPerTournamentTable(host: TableSessionHost): boolean {
  return perControllers.get(host)?.isTournament ?? false;
}

