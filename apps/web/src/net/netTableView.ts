/**
 * The networked table view: Poker.Game.TableView with SetLocalPerspective, built over the shared TableStage.
 *
 * The web TableView (src/table/tableView.ts) is the single-player port with identity seat mapping. Rather than change
 * it, this builds a TableView of its own whose seat HUDs, seat splines and pot-fly targets are *permuted arrays*:
 * index = logical (engine) seat, value = the physical slot's HUD/spline. SetLocalPerspective rewrites the arrays in
 * place, so every TableView call lands on the rotated slot while the 3D dealer keeps keying cards by logical seat —
 * which is exactly what lets RehomeHoleCards move dealt cards when a player sits down mid-hand.
 *
 * Also the network-only seat features Unity's SeatView has and the web SeatHud does not yet: the runtime-built
 * reaction bubble (SeatView.ShowReaction) and the voice indicators on the seat's Mic node (SeatView.SetVoiceState).
 */
import { Ease, ticker, type Tween } from '../anim/tween';
import type { Card } from '../core/cards/card';
import type { BettingPanelPort, SeatRole } from '../core/orchestration/tableView';
import type { SeatHudView } from '../hud/seatHud';
import { buildNode, HUD_DATA, UNode, type NodeData } from '../hud/unityUi';
import type { TableStage } from '../table/tableStage';
import { TableView, type PotHud, type SeatHud } from '../table/tableView';
import type { NetTableViewPort } from './clientGame';
import { isHiddenCard } from '../core/events/pokerEventCodec';

/** Test.unity: PokerClientGame.localPerspectiveSeat = seatViews[0] (Name_Canvas_Player). */
export const LOCAL_PERSPECTIVE_SLOT = 0;

const REACTIONS = (HUD_DATA as unknown as { reactions: { bubbleSeconds: number; popSeconds: number; popFromScale: number; bubbleSize: number; bubbleHeight: number; entries: { id: number; sprite: string }[] } }).reactions;

export class NetTableView implements NetTableViewPort {
  readonly localSlot = LOCAL_PERSPECTIVE_SLOT;
  private readonly inner: TableView;
  /** Logical seat → slot HUD / splines (mutated in place by setLocalPerspective). */
  private readonly seatHuds: SeatHud[];
  private readonly splines: TableStage['table']['seatSplines'];
  private seatToSlot: number[] | null = null;
  private readonly slotHuds: SeatHudView[];
  private readonly bubbles = new Map<number, { node: UNode; icon: UNode; pop: Tween | null; timer: Tween | null }>();
  private readonly mics = new Map<number, { root: UNode; unmute: UNode | null; mute: UNode | null; graph: UNode | null }>();
  private localPlayerSlot = -1;
  voiceEnabled = false;

  constructor(private readonly stage: TableStage) {
    this.slotHuds = [...stage.hud.seats];
    this.seatHuds = [...this.slotHuds];
    this.splines = [...stage.table.seatSplines];
    const hudPot = stage.hud.pot;
    const potTokens = stage.potTokens;
    const seatWorld = stage.seatWorld;
    const pot: PotHud = {
      setPot: (v) => {
        hudPot.setPot(v);
        potTokens.setPot(v);
      },
      setMessage: (m) => hudPot.setMessage(m),
      awardTokensTo: (seat) => {
        const slot = this.slot(seat);
        hudPot.awardTokensTo(slot);
        if (seatWorld[slot]) potTokens.awardTokensTo(seatWorld[slot]!);
      },
    };
    // A fresh view over the stage, exactly as TableStage.newView() builds one — with permuted seats.
    stage.slam.stop();
    stage.dealer.clear();
    this.inner = new TableView({ seats: this.seatHuds, betting: stage.hud.betting, pot }, stage.dealer, this.splines);
  }

  // ---- Perspective --------------------------------------------------------------------------------

  private slot(seat: number): number {
    return this.seatToSlot && seat >= 0 && seat < this.seatToSlot.length ? this.seatToSlot[seat]! : seat;
  }

  private hudOf(seat: number): SeatHudView | null {
    return this.slotHuds[this.slot(seat)] ?? null;
  }

  /** TableView.SetLocalPerspective (identity for negative values). */
  setLocalPerspective(localSeat: number, localSlot: number): void {
    const n = this.slotHuds.length;
    const previous = this.seatToSlot;
    if (n === 0 || localSeat < 0 || localSlot < 0) this.seatToSlot = null;
    else {
      this.seatToSlot = [];
      for (let seat = 0; seat < n; seat++) this.seatToSlot[seat] = (((localSlot + (seat - localSeat)) % n) + n) % n;
    }
    this.localPlayerSlot = this.seatToSlot ? localSlot : -1;
    if (sameMapping(previous, this.seatToSlot)) return;

    // Move what a seat carries (bubbles, mic) along with it.
    const bubbleBySeat = new Map<number, number>();
    for (let seat = 0; seat < n; seat++) {
      const oldSlot = previous ? previous[seat]! : seat;
      bubbleBySeat.set(seat, oldSlot);
    }
    for (let seat = 0; seat < n; seat++) {
      const s = this.slot(seat);
      this.seatHuds[seat] = this.slotHuds[s]!;
      this.splines[seat] = this.stage.table.seatSplines[s]!;
    }
    // Sitting down mid-hand rotates the table under cards already on the felt: bring them along, and drop the HUD's
    // own hole-card readout, which belongs to whoever sat in that slot before.
    for (let seat = 0; seat < n; seat++) {
      this.seatHuds[seat]!.setHoleCards(null, null, false);
      const sp = this.splines[seat];
      if (sp) this.stage.dealer.rehomeHoleCards(seat, sp[0], sp[1]);
    }
    for (const b of this.bubbles.values()) this.hideBubble(b);
    this.refreshMics();
  }

  // ---- TableViewPort (delegated with the rotation applied by the permuted arrays) ----------------

  get seatCount(): number {
    return this.inner.seatCount;
  }

  get betting(): BettingPanelPort {
    return this.inner.betting;
  }

  bindSeat(seat: number, playerName: string, stack: number, isBot: boolean, avatar: number, avatarName: string | null): void {
    this.inner.bindSeat(seat, playerName, stack, isBot, avatar, avatarName);
    this.refreshMic(seat);
  }

  hideSeat(seat: number): void {
    this.inner.hideSeat(seat);
  }

  beginHand(handNumber: number): void {
    this.inner.beginHand(handNumber);
  }

  resetSeatForHand(seat: number, stack: number, role: SeatRole, busted: boolean): void {
    this.inner.resetSeatForHand(seat, stack, role, busted);
    // SeatView.ResetForNewHand: a reaction to the last hand has nothing to say about this one.
    const b = this.bubbles.get(this.slot(seat));
    if (b) this.hideBubble(b);
  }

  showBlind(seat: number, stackAfter: number, currentBet: number, potAfter: number): void {
    this.inner.showBlind(seat, stackAfter, currentBet, potAfter);
  }

  showHoleCards(seat: number, card0: Card, card1: Card, faceUp: boolean): void {
    // A hidden card (another player's) is dealt face down; its face is never set.
    if (!faceUp && (isHiddenCard(card0) || isHiddenCard(card1))) {
      const v = this.hudOf(seat);
      v?.hideHandStrength();
      const sp = this.splines[seat];
      if (sp) this.stage.dealer.dealHoleCards(seat, sp[0], sp[1], { rank: 2, suit: 0 }, { rank: 2, suit: 0 }, false);
      return;
    }
    this.inner.showHoleCards(seat, card0, card1, faceUp);
  }

  showBoard(newCards: Card[], board: Card[]): void {
    this.inner.showBoard(newCards, board);
  }

  showAction(seat: number, stackAfter: number, currentBet: number, description: string, potAfter: number, folded: boolean): void {
    this.inner.showAction(seat, stackAfter, currentBet, description, potAfter, folded);
  }

  showShowdown(seat: number, card0: Card, card1: Card, description: string): void {
    this.inner.showShowdown(seat, card0, card1, description);
  }

  showPotAward(seat: number, stackAfter: number, message: string, pot: number): void {
    this.inner.showPotAward(seat, stackAfter, message, pot);
  }

  endHand(): void {
    this.inner.endHand();
  }

  showMessage(message: string): void {
    this.inner.showMessage(message);
  }

  showGameOver(message: string): void {
    this.inner.showGameOver(message);
  }

  setTurn(seat: number, timerSeconds: number, elapsedSeconds = 0): void {
    // TableView.SetTurn walks hud.seats by index = logical seat (the permuted array), so the rotation applies.
    this.inner.setTurn(seat, timerSeconds, elapsedSeconds);
  }

  clearTurn(seat: number): void {
    this.inner.clearTurn(seat);
  }

  // ---- Network-only TableView methods --------------------------------------------------------

  updateSeatLabel(seat: number, playerName: string, isBot: boolean, avatar: number, avatarName: string | null): void {
    const v = this.hudOf(seat);
    if (!v) return;
    v.setVisible(true);
    v.bind(playerName, avatar, avatarName ?? playerName);
    v.setBot(isBot);
    this.refreshMic(seat);
  }

  isSeatVisible(seat: number): boolean {
    return this.hudOf(seat)?.visible ?? false;
  }

  hideAllSeats(): void {
    for (const v of this.slotHuds) v.setVisible(false);
  }

  clearTable(): void {
    this.inner.clearTable();
  }

  /** SeatView.ShowReaction: a runtime-built bubble 415 units above the seat, popped 0.6→1 over 0.18 s, 3 s up. */
  showReaction(seat: number, reactionId: number): void {
    const v = this.hudOf(seat);
    if (!v || !v.visible) return;
    const entry = REACTIONS.entries.find((e) => e.id === reactionId);
    const sprite = entry ? HUD_DATA.sprites[entry.sprite] : undefined;
    if (!sprite) return;
    const slot = this.slot(seat);
    let b = this.bubbles.get(slot);
    if (!b) {
      const node = new UNode('Reaction_Bubble');
      node.anchorMin = [0.5, 0.5];
      node.anchorMax = [0.5, 0.5];
      node.pivot = [0.5, 0.5];
      node.sizeDelta = [REACTIONS.bubbleSize, REACTIONS.bubbleSize];
      node.anchoredPosition = [0, REACTIONS.bubbleHeight];
      node.foldBrightness = -1; // left out of the fold tint: it speaks for the player, not the hand
      const icon = node;
      icon.image = {
        sprite, type: 'Simple', ppuM: 1, color: { r: 1, g: 1, b: 1, a: 1 }, preserveAspect: true,
        fillMethod: '', fillAmount: 1, fillOrigin: 0, fillClockwise: true,
      };
      node.el.style.pointerEvents = 'none';
      v.root.add(node); // SetAsLastSibling: over the avatar disc and the win medal
      b = { node, icon, pop: null, timer: null };
      this.bubbles.set(slot, b);
    }
    this.hideBubble(b);
    b.icon.image!.sprite = sprite;
    b.node.setActive(true);
    b.node.scale = [REACTIONS.popFromScale, REACTIONS.popFromScale];
    b.node.layout();
    const bubble = b;
    // Unscaled time in Unity (a reaction is a person, not part of the hand): run on real seconds.
    const scale = ticker.timeScale || 1;
    b.pop = ticker.to(REACTIONS.popSeconds / scale, (p) => {
      const k = 1 - (1 - p) * (1 - p);
      const s = REACTIONS.popFromScale + (1 - REACTIONS.popFromScale) * k;
      bubble.node.scale = [s, s];
      bubble.node.layout();
    }, Ease.Linear);
    b.timer = ticker.delayedCall((REACTIONS.popSeconds + REACTIONS.bubbleSeconds) / scale, () => this.hideBubble(bubble));
  }

  private hideBubble(b: { node: UNode; pop: Tween | null; timer: Tween | null }): void {
    b.pop?.kill();
    b.pop = null;
    b.timer?.kill();
    b.timer = null;
    b.node.setActive(false);
  }

  /** SeatView.SetVoiceState on the seat's nested Mic prefab (Graphics/Name_bar/Mic). Mute wins over talking. */
  setVoiceState(seat: number, talking: boolean, muted: boolean): void {
    const m = this.micOf(this.slot(seat));
    if (!m) return;
    m.root.setActive(this.voiceEnabled);
    m.mute?.setActive(muted);
    m.unmute?.setActive(!muted);
    m.graph?.setActive(talking && !muted);
  }

  private micOf(slot: number): { root: UNode; unmute: UNode | null; mute: UNode | null; graph: UNode | null } | null {
    if (!this.voiceEnabled) return null;
    let m = this.mics.get(slot);
    if (m) return m;
    const hud = this.slotHuds[slot];
    if (!hud) return null;
    // The seat HUD skips the Mic node (voice is off in the shipped build); build it from the same extracted prefab.
    const canvas = HUD_DATA.canvases.filter((c) => c.role === 'seat').sort((a, b) => (a.seatSlot ?? 0) - (b.seatSlot ?? 0))[slot];
    const data = findNode(canvas?.root, ['Graphics', 'Name_bar', 'Mic']);
    const parent = hud.root.find('Graphics/Name_bar');
    if (!data || !parent) return null;
    const root = buildNode(data);
    parent.add(root);
    root.setActive(true);
    root.layout();
    m = { root, unmute: root.find('Unmute'), mute: root.find('mute'), graph: root.find('Sound_Graph') };
    this.mics.set(slot, m);
    return m;
  }

  /** PokerSeatMic: the local seat's mic is the mute control; remote seats only indicate. */
  micRootForLocal(): UNode | null {
    return this.localPlayerSlot >= 0 ? (this.micOf(this.localPlayerSlot)?.root ?? null) : null;
  }

  private refreshMic(seat: number): void {
    if (!this.voiceEnabled) return;
    const m = this.micOf(this.slot(seat));
    m?.root.setActive(true);
  }

  private refreshMics(): void {
    if (!this.voiceEnabled) return;
    for (let slot = 0; slot < this.slotHuds.length; slot++) this.micOf(slot);
  }

  /** Removes everything this view added to the shared HUD (bubbles, mics). */
  dispose(): void {
    for (const b of this.bubbles.values()) {
      this.hideBubble(b);
      b.node.el.remove();
      const p = b.node.parent;
      if (p) p.children.splice(p.children.indexOf(b.node), 1);
    }
    this.bubbles.clear();
    for (const m of this.mics.values()) {
      m.root.el.remove();
      const p = m.root.parent;
      if (p) p.children.splice(p.children.indexOf(m.root), 1);
    }
    this.mics.clear();
  }
}

function sameMapping(a: number[] | null, b: number[] | null): boolean {
  if (!a || !b) return !a && !b;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function findNode(root: NodeData | undefined, path: string[]): NodeData | null {
  let n: NodeData | undefined = root;
  for (const name of path) {
    n = n?.children?.find((c) => c.name === name);
    if (!n) return null;
  }
  return n ?? null;
}
