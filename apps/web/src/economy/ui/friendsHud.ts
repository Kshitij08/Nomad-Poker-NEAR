/**
 * Port of Social/FriendsHud.cs as the shipped flow shows it: the designer "Friends panel ui" sheet (extracted from
 * the RetentionHud in the menu scene; FriendsHud.TryBindDesignerPanel) with the runtime list rows, the avatar
 * picker, and the "X invited you to play" toast — plus the polling that keeps them fed (list every 30 s, 10 s while
 * the sheet is open; the invite mailbox every 10 s while not at a table).
 *
 * The Nomad menu has its own Friends screen (menu module, NomadUiHost.Social); what reaches THIS sheet in the
 * shipped flow is its Edit Avatar / Edit Picture buttons (FriendsHud.OpenAvatarPicker) and the toast. The sheet is
 * the router overlay 'friends'; the toast lives on a persistent layer above every screen (FriendsCanvas order 510).
 *
 * Faithful quirks kept: the designer sheet has no "Status" label, so status lines are not shown there; its
 * PlayerName / FriendsCount texts are not bound by FriendsHud (they keep the designer text).
 */
import type { AppContext, Screen } from '../../app/app';
import type { UNode } from '../../hud/unityUi';
import { PokerSound } from '@nomad/engine/orchestration/pokerSound';
import { AvatarCatalog } from '@nomad/engine/social/avatarCatalog';
import { FriendCode } from '@nomad/engine/social/friendCode';
import { FriendLastSeen, FriendRelation, FriendTags } from '@nomad/engine/social/friendRules';
import { PokerClientIdentity } from '../identity';
import { PlayFabAuth } from '../playfab/auth';
import { FriendInvites, inviteLabel, type FriendInvite } from '../social/friendInvites';
import { friendLabel, PlayFabFriends, type FriendEntry } from '../social/playFabFriends';
import { PlayerAvatar, PlayFabAvatar } from '../social/playerAvatar';
import {
  applyAspectFitter, attachInput, avatarSprite, buildEconomyCanvas, clean, DEFAULT_SCALER, makeButton, makeNode,
  OverlayCanvas, place, RetentionUiColors as C, setImage, setLabel, stretch, unityColor, wireButton, WHITE,
} from './canvas';
import './economy.css';

const InboxPollSeconds = 10;
const ListPollSeconds = 30;
const ListPollOpenSeconds = 10;
const ConfirmRemoveSeconds = 4;
const Grey = unityColor(0.28, 0.3, 0.36);
const Danger = unityColor(0.58, 0.25, 0.25);

interface RowButtonSpec {
  caption: string;
  color: ReturnType<typeof unityColor>;
  enabled: boolean;
  action: () => void;
  darkLabel?: boolean;
}

const realtime = () => performance.now() / 1000;
const signedIn = () => PlayFabAuth.isSignedIn && PokerClientIdentity.isPlayFabSignedIn;

export class FriendsHud {
  private readonly layer = document.createElement('div');
  private readonly toastCanvas: OverlayCanvas;
  private readonly toast: { node: UNode; avatar: UNode; title: UNode; detail: UNode };
  private toastInvite: FriendInvite | null = null;
  private sheet: FriendsSheet | null = null;
  private pendingPicker = false;

  private busy = false;
  private joining = false;
  private wasAtTable = false;
  private playerId: string | null = null;
  private nextInboxPoll = 0;
  private nextListPoll = 0;
  confirmRemoveId: string | null = null;
  private confirmRemoveUntil = 0;

  constructor(private readonly ctx: AppContext) {
    this.layer.className = 'econ-layer';
    document.body.append(this.layer);
    const root = makeNode('FriendsCanvas');
    this.toast = this.buildToast(root);
    this.toastCanvas = new OverlayCanvas(this.layer, root, DEFAULT_SCALER, 510);
    PlayFabFriends.changed.on(() => this.onFriendsChanged());
    FriendInvites.changed.on(() => this.refreshToast());
    FriendInvites.tableChanged.on(() => this.tick());
    PlayerAvatar.changed.on(() => this.sheet?.onOwnAvatarChanged());
    PokerClientIdentity.changed.on(() => this.sheet?.updateIdLabel());
    setInterval(() => this.tick(), 1000);
    queueMicrotask(() => this.tick());
  }

  get atTable(): boolean {
    return FriendInvites.currentTable !== null;
  }
  get panelOpen(): boolean {
    return this.sheet !== null;
  }

  /** The 'friends' router overlay. */
  screen(ctx: AppContext): Screen {
    return {
      overlay: true,
      mount: (root) => {
        this.sheet = new FriendsSheet(ctx, this, root);
        this.confirmRemoveId = null;
        this.sheet.updateIdLabel();
        this.sheet.renderList();
        this.nextListPoll = 0; // fresh data on open
        if (this.pendingPicker) {
          this.pendingPicker = false;
          this.sheet.openPicker();
        }
      },
      unmount: () => {
        this.sheet?.dispose();
        this.sheet = null;
        this.confirmRemoveId = null;
      },
    };
  }

  openPanel(): void {
    if (this.sheet) return;
    void this.ctx.router.push('friends');
  }

  togglePanel(): void {
    if (this.sheet) this.closePanel();
    else this.openPanel();
  }

  closePanel(): void {
    if (this.sheet && this.ctx.router.current === 'friends') this.ctx.router.back();
  }

  openAvatarPicker(): void {
    if (this.sheet) this.sheet.openPicker();
    else {
      this.pendingPicker = true;
      this.openPanel();
    }
  }

  // ---- polling (FriendsHud.Tick / Poll)

  private tick(): void {
    const atTable = this.atTable;
    if (atTable !== this.wasAtTable) {
      this.wasAtTable = atTable;
      this.refreshToast();
      this.sheet?.renderList();
    }
    if (this.confirmRemoveId !== null && realtime() > this.confirmRemoveUntil) {
      this.confirmRemoveId = null;
      this.sheet?.renderList();
    }
    this.poll();
  }

  private poll(): void {
    if (!signedIn()) return;
    const id = PokerClientIdentity.playFabId;
    if (id !== this.playerId) {
      if (this.playerId !== null) {
        PlayFabFriends.clear();
        FriendInvites.clear();
      }
      this.playerId = id;
      this.nextListPoll = 0;
      this.nextInboxPoll = 0;
      this.sheet?.updateIdLabel();
      void PlayFabAvatar.pullAsync();
    }
    const now = realtime();
    if (now >= this.nextListPoll) {
      this.nextListPoll = now + (this.panelOpen ? ListPollOpenSeconds : ListPollSeconds);
      void PlayFabFriends.refreshAsync();
    }
    if (!this.atTable && now >= this.nextInboxPoll) {
      this.nextInboxPoll = now + InboxPollSeconds;
      void FriendInvites.pollAsync();
    }
  }

  private onFriendsChanged(): void {
    this.sheet?.renderList();
  }

  // ---- actions (shared with the sheet)

  armConfirmRemove(id: string): boolean {
    if (this.confirmRemoveId !== id || realtime() > this.confirmRemoveUntil) {
      this.confirmRemoveId = id;
      this.confirmRemoveUntil = realtime() + ConfirmRemoveSeconds;
      return true;
    }
    this.confirmRemoveId = null;
    return false;
  }

  /** One action at a time; the result is left on the status line (FriendsHud.RunAsync). */
  async run(action: () => Promise<string | null>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.sheet?.setAddInteractable(false);
    this.sheet?.setStatus('Working…');
    try {
      this.sheet?.setStatus(await action());
    } catch (e) {
      console.error('[Friends] Action threw', e);
      this.sheet?.setStatus('Something went wrong. Try again.');
    } finally {
      this.busy = false;
      this.sheet?.setAddInteractable(true);
      this.sheet?.renderList();
    }
  }

  get isBusy(): boolean {
    return this.busy;
  }

  // ---- toast

  private buildToast(canvasRoot: UNode): FriendsHud['toast'] {
    const node = setImage(makeNode('InviteToast', { anchorMin: [0.5, 1], anchorMax: [0.5, 1], pivot: [0.5, 1], pos: [0, -104], size: [640, 154] }), C.Panel);
    node.el.classList.add('econ-interactive');
    canvasRoot.add(node);
    // VerticalLayoutGroup padding 20/20/14/14, spacing 8: header row 58, buttons row 44.
    const avatar = setImage(place(makeNode('Avatar'), 20, 14, 54, 58), WHITE, null, 'Simple', true);
    const title = setLabel(place(makeNode('Title'), 84, 14, 536, 30), '', 22, C.Gold, { bold: true, alignH: 'left' });
    const detail = setLabel(place(makeNode('Detail'), 84, 14 + 32, 536, 24), '', 16, C.Muted, { alignH: 'left' });
    node.add(avatar);
    node.add(title);
    node.add(detail);
    const join = makeButton(this.ctx, 'JoinButton', 'Join', C.Gold, () => void this.joinAsync(), { labelColor: C.SpinLabelDark, sound: PokerSound.ButtonStart });
    const decline = makeButton(this.ctx, 'DeclineButton', 'Decline', Grey, () => {
      if (this.toastInvite) FriendInvites.decline(this.toastInvite);
    });
    node.add(place(join.node, 20, 80, 294, 44));
    node.add(place(decline.node, 20 + 294 + 12, 80, 294, 44));
    node.setActive(false);
    return { node, avatar, title, detail };
  }

  private refreshToast(): void {
    const inbox = FriendInvites.inbox;
    this.toastInvite = this.atTable || inbox.length === 0 ? null : inbox[0]!;
    const show = this.toastInvite !== null && !this.joining;
    this.toast.node.setActive(show);
    if (show) {
      const inv = this.toastInvite!;
      this.toast.title.setText(`${clean(inviteLabel(inv))} invited you to play`);
      const friend = PlayFabFriends.find(inv.fromId);
      const face = avatarSprite(friend?.avatar ?? AvatarCatalog.None, inviteLabel(inv));
      if (face && this.toast.avatar.image) {
        this.toast.avatar.image.sprite = face;
        this.toast.avatar.render();
      }
      const table = inv.money ? 'Real-money table' : 'Free table';
      const more = inbox.length > 1 ? `  ·  +${inbox.length - 1} more` : '';
      this.toast.detail.setText(`${table}  ·  ${inv.session}${more}`);
      this.toastCanvas.layout();
    }
  }

  private async joinAsync(): Promise<void> {
    const invite = this.toastInvite;
    if (!invite || this.joining) return;
    this.joining = true;
    this.closePanel();
    this.toast.node.setActive(false);
    let error: string | null;
    try {
      error = await FriendInvites.acceptAsync(invite);
    } catch (e) {
      console.error('[Invites] Join threw', e);
      error = "Couldn't join that table.";
    } finally {
      this.joining = false;
    }
    if (error === null) return;
    this.refreshToast();
    if (this.toast.node.activeSelf) this.toast.detail.setText(error);
  }
}

/** The designer sheet + avatar picker, mounted while the 'friends' overlay is up. */
class FriendsSheet {
  private readonly canvas: OverlayCanvas;
  private readonly root: UNode;
  private readonly list: UNode;
  private readonly idLabel: UNode | null;
  private readonly profileAvatar: UNode | null;
  private readonly addInput: HTMLInputElement | null;
  private readonly addButton: ReturnType<typeof wireButton>;
  private readonly picker: UNode;
  private readonly pickerGrid: UNode;
  private listHeight = 0;

  constructor(private readonly ctx: AppContext, private readonly hud: FriendsHud, mountEl: HTMLElement) {
    const built = buildEconomyCanvas('friendsPanel');
    this.root = built.root;
    this.root.setActive(true);
    mountEl.classList.add('econ-screen');
    this.canvas = new OverlayCanvas(mountEl, this.root, DEFAULT_SCALER, 510);

    const backdrop = this.root.find('Backdrop');
    const arf = backdrop ? built.dataOf(backdrop)?.components?.aspectRatioFitter : undefined;
    if (backdrop && arf) this.canvas.onBeforeLayout(() => applyAspectFitter(backdrop, arf.mode, arf.ratio));

    const close = () => hud.closePanel();
    wireButton(ctx, this.root.find('Dimmer'), close, undefined, null);
    wireButton(ctx, this.root.find('Sheet/CloseButton'), close);
    this.addButton = wireButton(ctx, this.root.find('Sheet/AddButton'), () => this.onAdd());
    wireButton(ctx, this.root.find('Sheet/CopyIdButton'), () => this.onCopyId());
    wireButton(ctx, this.root.find('Sheet/PictureButton'), () => this.openPicker());
    const search = this.root.find('Sheet/SearchInput');
    this.addInput = search ? attachInput(search, { onSubmit: () => this.onAdd() }) : null;
    this.idLabel = this.root.find('Sheet/FriendId');
    if (this.idLabel?.text) this.idLabel.text.rich = true;
    this.profileAvatar = this.root.find('Sheet/Avatar');
    if (this.profileAvatar) wireButton(ctx, this.profileAvatar, () => this.openPicker(), undefined, null);

    // FriendsList has no ScrollRect: the list root is FriendsList itself, given a VerticalLayoutGroup (spacing 8,
    // padding 8) + ContentSizeFitter (preferred height) by EnsureListLayout; the designer FriendRow_* are hidden.
    this.list = this.root.find('Sheet/FriendsList')!;
    for (const c of this.list.children) if (c.name.startsWith('FriendRow')) c.setActive(false);
    this.canvas.onBeforeLayout(() => {
      const ph = this.list.parent?.h ?? 0;
      this.list.sizeDelta = [this.list.sizeDelta[0], this.listHeight - ph];
    });

    const pick = this.buildPicker();
    this.picker = pick.root;
    this.pickerGrid = pick.grid;
    this.root.add(this.picker);
    this.picker.setActive(false);
    this.canvas.layout();
  }

  dispose(): void {
    this.canvas.dispose();
  }

  setStatus(_message: string | null): void {
    // The designer sheet has no "Status" label (FriendsHud._statusLabel stays null): nothing to show.
  }

  setAddInteractable(v: boolean): void {
    this.addButton?.setInteractable(v);
  }

  updateIdLabel(): void {
    if (this.profileAvatar?.image) {
      const sprite = avatarSprite(PlayerAvatar.current, PokerClientIdentity.playerName);
      if (sprite) {
        this.profileAvatar.image.sprite = sprite;
        this.profileAvatar.render();
      }
    }
    if (!this.idLabel) return;
    const id = PokerClientIdentity.playFabId;
    const friendId = signedIn() && id ? FriendCode.format(id) : '<color=#FFFFFF80>signing in…</color>';
    this.idLabel.setText(`<b>${clean(PokerClientIdentity.playerName)}</b>\n<size=80%><color=#FFFFFFB0>Friend ID  ${friendId}</color></size>`);
  }

  onOwnAvatarChanged(): void {
    this.updateIdLabel();
    if (this.picker.activeSelf) this.renderPicker();
  }

  // ---- list (FriendsHud.RenderList)

  renderList(): void {
    for (const c of [...this.list.children]) {
      if (c.name.startsWith('FriendRow')) continue;
      this.list.children.splice(this.list.children.indexOf(c), 1);
      c.el.remove();
    }
    const items: { node: UNode; h: number }[] = [];
    const W = () => this.list.w - 16;
    const note = (text: string) => items.push({ node: setLabel(makeNode('Note'), text, 16, C.Muted), h: 56 });
    const header = (text: string) => items.push({ node: setLabel(makeNode('Header'), text, 15, C.Gold, { bold: true, alignH: 'left', alignV: 'bottom' }), h: 28 });

    if (!signedIn()) note('Signing in…');
    else if (!PlayFabFriends.hasLoaded) note(PlayFabFriends.lastError ?? 'Loading friends…');
    else {
      const incoming: FriendEntry[] = [];
      const friends: FriendEntry[] = [];
      const outgoing: FriendEntry[] = [];
      for (const e of PlayFabFriends.all) {
        if (e.relation === FriendRelation.IncomingRequest) incoming.push(e);
        else if (e.relation === FriendRelation.Friend) friends.push(e);
        else if (e.relation === FriendRelation.OutgoingRequest) outgoing.push(e);
      }
      if (incoming.length > 0) {
        header(`REQUESTS  (${incoming.length})`);
        for (const e of incoming) {
          items.push({ node: this.row(e, 'Wants to be friends', W(), [
            { caption: 'Accept', color: C.Gold, enabled: true, action: () => this.accept(e), darkLabel: true },
            { caption: 'Decline', color: Grey, enabled: true, action: () => this.remove(e, 'Request declined.') },
          ]), h: 64 });
        }
      }
      header(`FRIENDS  (${friends.length})`);
      if (friends.length === 0) note('No friends yet. Share your Friend ID, or add someone by theirs.');
      const atTable = this.hud.atTable;
      const now = Date.now();
      for (const e of friends) {
        const confirming = this.hud.confirmRemoveId === e.id;
        items.push({ node: this.row(e, FriendLastSeen.describe(e.lastLogin, now), W(), [
          { caption: 'Invite', color: C.Accent, enabled: atTable, action: () => this.invite(e) },
          { caption: confirming ? 'Sure?' : 'Remove', color: Danger, enabled: true, action: () => this.confirmRemove(e) },
        ]), h: 64 });
      }
      if (outgoing.length > 0) {
        header('SENT');
        for (const e of outgoing) {
          items.push({ node: this.row(e, 'Waiting for them to accept', W(), [
            { caption: 'Cancel', color: Grey, enabled: true, action: () => this.remove(e, 'Request cancelled.') },
          ]), h: 64 });
        }
      }
    }
    // VerticalLayoutGroup: padding 8, spacing 8, UpperCenter, control + expand width.
    let y = 8;
    items.forEach(({ node, h }, i) => {
      this.list.add(place(node, 8, y, W(), h));
      y += h + (i < items.length - 1 ? 8 : 0);
    });
    this.listHeight = y + 8;
    this.canvas.layout();
  }

  /** FriendsHud.AddRow: 64 high, HorizontalLayoutGroup padding 10/10/8/8 spacing 10, MiddleLeft. */
  private row(entry: FriendEntry, detail: string, width: number, buttons: RowButtonSpec[]): UNode {
    const row = setImage(makeNode('Row'), C.Reel);
    let x = 10;
    const face = avatarSprite(entry.avatar, friendLabel(entry));
    const avatar = setImage(place(makeNode('Avatar'), x, 8, 48, 48), WHITE, face, 'Simple', true);
    if (!face) avatar.image = null;
    row.add(avatar);
    x += 48 + 10;
    const btnW = buttons.length * 104 + buttons.length * 10;
    const sub = detail ? `\n<size=75%><color=#FFFFFF8C>${detail}</color></size>` : '';
    const label = setLabel(place(makeNode('Name'), x, 8, Math.max(0, width - x - 10 - btnW), 48), `<b>${clean(friendLabel(entry))}</b>${sub}`, 19, WHITE, { alignH: 'left', rich: true });
    row.add(label);
    let bx = width - 10 - btnW + 10;
    for (const spec of buttons) {
      const b = makeButton(this.ctx, spec.caption, spec.caption, spec.color, () => {
        if (!this.hud.isBusy) spec.action();
      }, { fontSize: 18, labelColor: spec.darkLabel ? C.SpinLabelDark : WHITE });
      b.button.setInteractable(spec.enabled);
      row.add(place(b.node, bx, 12, 104, 40));
      bx += 104 + 10;
    }
    return row;
  }

  // ---- actions

  private onAdd(): void {
    const input = this.addInput?.value ?? null;
    void this.hud.run(async () => {
      const result = await PlayFabFriends.sendRequestAsync(input);
      if (!result.success) return result.error;
      if (this.addInput) {
        this.addInput.value = '';
        this.addInput.dispatchEvent(new Event('input'));
      }
      return result.relation === FriendTags.Friend ? "They'd already asked you, so you're now friends." : 'Request sent.';
    });
  }

  private onCopyId(): void {
    const id = PokerClientIdentity.playFabId;
    if (!id) return;
    void navigator.clipboard?.writeText(FriendCode.format(id)).catch(() => {});
    this.setStatus('Friend ID copied. Send it to a friend.');
  }

  private accept(f: FriendEntry): void {
    void this.hud.run(async () => {
      const r = await PlayFabFriends.acceptAsync(f.id);
      return r.success ? `You and ${friendLabel(f)} are now friends.` : r.error;
    });
  }

  private invite(f: FriendEntry): void {
    void this.hud.run(async () => {
      const r = await FriendInvites.inviteAsync(f);
      return r.success ? `Invite sent to ${friendLabel(f)}.` : r.error;
    });
  }

  private confirmRemove(f: FriendEntry): void {
    if (this.hud.armConfirmRemove(f.id)) {
      this.renderList();
      return;
    }
    this.remove(f, `Removed ${friendLabel(f)}.`);
  }

  private remove(f: FriendEntry, done: string): void {
    void this.hud.run(async () => {
      const r = await PlayFabFriends.removeAsync(f.id);
      return r.success ? done : r.error;
    });
  }

  // ---- avatar picker (FriendsHud.BuildAvatarPicker / RenderPicker)

  private buildPicker(): { root: UNode; grid: UNode } {
    const root = stretch(makeNode('AvatarPicker'));
    const dim = setImage(stretch(makeNode('Dimmer')), C.Overlay);
    wireButton(this.ctx, dim, () => this.closePicker(), undefined, null);
    root.add(dim);
    const sheet = setImage(makeNode('Sheet', { size: [700, 720] }), C.Panel);
    root.add(sheet);
    // VerticalLayoutGroup padding 28/28/24/24, spacing 14: title 38, grid 4×104 + 3×16, close 46.
    sheet.add(setLabel(place(makeNode('Title'), 28, 24, 644, 38), 'CHOOSE YOUR PICTURE', 28, C.Gold, { bold: true }));
    const grid = place(makeNode('Grid'), 28, 24 + 38 + 14, 644, 4 * 104 + 3 * 16);
    sheet.add(grid);
    const close = makeButton(this.ctx, 'CloseButton', 'Close', Grey, () => this.closePicker());
    sheet.add(place(close.node, 28, 24 + 38 + 14 + 464 + 14, 644, 46));
    return { root, grid };
  }

  openPicker(): void {
    this.picker.setActive(true);
    this.renderPicker();
  }

  private closePicker(): void {
    this.picker.setActive(false);
  }

  private renderPicker(): void {
    for (const c of [...this.pickerGrid.children]) c.el.remove();
    this.pickerGrid.children.length = 0;
    const shown = PlayerAvatar.shown(PokerClientIdentity.playerName);
    // GridLayoutGroup: 104×104 cells, 16 spacing, 5 columns, UpperCenter (5×104 + 4×16 = 584 in a 644 row).
    const left = (644 - 584) / 2;
    for (let n = 1; n <= AvatarCatalog.count; n++) {
      const sprite = avatarSprite(n, null);
      if (!sprite) continue;
      const i = n - 1;
      const cell = setImage(place(makeNode('Avatar_' + n), left + (i % 5) * 120, Math.floor(i / 5) * 120, 104, 104), n === shown ? C.Gold : unityColor(1, 1, 1, 0.08));
      const face = setImage(stretch(makeNode('Face'), 6, 6, 6, 6), WHITE, sprite, 'Simple', true);
      cell.add(face);
      wireButton(this.ctx, cell, () => this.onAvatarPicked(n));
      this.pickerGrid.add(cell);
    }
    this.canvas.layout();
  }

  private onAvatarPicked(avatar: number): void {
    PlayerAvatar.choose(avatar);
    this.closePicker();
    this.setStatus(this.hud.atTable ? 'Picture updated. Everyone at the table sees it now.' : 'Picture updated. Friends and tables will see it.');
  }
}
