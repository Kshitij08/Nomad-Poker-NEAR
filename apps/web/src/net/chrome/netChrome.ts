/**
 * The networked table's chrome, registered with addTableChrome and drawn only while a net session is live.
 * Redesign v2 (docs/ui-style-guide.md › Table HUD): plain DOM in the shared table chrome slots (src/ui2/tableChrome.ts)
 * instead of the extracted uGUI canvases; the behaviour is the Unity components':
 *
 *  - PokerChatPanel     → chat toggle (+ unread badge) in the top-right bar, a drawer (landscape) / bottom sheet
 *                         (portrait): log, preset chips, input, Send with cooldown, link status
 *  - PokerReactionPanel → reactions toggle in the top-right bar, a tray of the whole ReactionLibrary, cooldown
 *  - SeatActionButtons / PokerLobbyView → the pre-game row (Join table, + Add Bot, Start game / Play again with the
 *                         reason it can't start yet) and the room code chip (tap to copy) next to Leave
 *  - PrivateBuyInPrompt → the web3 module's 'private-buy-in' screen, else a v2 sheet (500–1,000 Coins)
 *  - PokerSeatMic on the local seat (voice on only with ?voice=1, as Unity ships voice off)
 *
 * A table with no server behind it (the offline engine, the practice tournament: TableSession.localPlayerSeated) gets
 * the same chat and reactions, kept on this screen: your messages go to your own log (LocalChat) and your reaction
 * pops over your seat (LocalReactions). Live tournament tables are net sessions and use the server path.
 *
 * Leaving the table is the menu's Leave / Settings (NomadTableHud) → host.leave() → NetTableSession.stop(), which is
 * TableDisconnectButton's sequence (leave RPC, 0.75 s, shut the runner down).
 */
import type { AppContext } from '../../app/app';
import { PokerSound } from '@nomad/engine/orchestration/pokerSound';
import { TablePhase } from '@nomad/engine/events/pokerEvent';
import { assetUrl, HUD_DATA, type NodeData } from '../../hud/unityUi';
import type { TableChrome, TableSessionHost } from '../../table/tableScreen';
import type { ClientGame } from '../clientGame';
import type { NetService, NetTableSession } from '../netService';
import { PokerChatRateLimiter, PokerChatSettings, PokerChatText } from '@nomad/table-server/chat';
import { ChainTableMode, StakeSessionNames } from '@nomad/table-server/sessions';
import { TableChat, ChatLinkState, type PokerChatRow } from '../tableChat';
import { VoiceLinkState } from '../voice/tableVoice';
import { ReactionBubbles, LOCAL_PERSPECTIVE_SLOT } from '../netTableView';
import '../../ui2/table.css'; // v2 pre-game row rule (html.v2t-pregame)
import { v2tEl } from '../../ui2/tableKit';
import { Friends, friendLabel, type FriendEntry } from '../../economy/social/friends';
import { FriendInvites } from '../../economy/social/friendInvites';
import { FriendRelation } from '@nomad/engine/social/friendRules';
import { NomadLink } from '../../economy/nomadLink';
import { isPortrait } from '../../layout/orientation';
import { VerifyView } from './verifyPanel';
import { chromeSlots, chipButton, iconButton, tableSheet, tableToast, tIcon, type ChromeSlots } from '../../ui2/tableChrome';

const SCREEN = HUD_DATA.canvases.find((c) => c.role === 'screen-hud')!;
const child = (name: string): NodeData | undefined => SCREEN.root.children?.find((c) => c.name === name);
type Fields = Record<string, unknown>;
const fieldsOf = (d: NodeData | undefined): Fields => ((d?.components as { other?: { fields?: Fields }[] } | undefined)?.other?.[0]?.fields ?? {}) as Fields;
/** Chat feed: at most this many messages on screen, each up for this long. */
const FEED_MAX = 4;
const FEED_SECONDS = 7;
const REACTIONS = (HUD_DATA as unknown as { reactions: { entries: { id: number; sprite: string }[] } }).reactions;
/** Sender name colours (PokerChatPanel.senderPalette, re-picked to read on the v2 purple). */
const NAME_COLORS = ['#ffd54a', '#6af0a0', '#7fd0ff', '#ff9ad5', '#c3a6ff', '#ffb36b', '#9ef0ff', '#ff8a9a'];
const n0 = (v: number): string => v.toLocaleString('en-US');

type Audio = { play(s: PokerSound): void };
const nowSeconds = (): number => performance.now() / 1000;

/** What the chat drawer reads: the table socket's TableChat, or LocalChat at a table with no server. */
type ChatPort = Pick<TableChat, 'state' | 'isAvailable' | 'canSend' | 'sendCooldownRemaining' | 'log' | 'send' | 'messageAdded' | 'logCleared' | 'stateChanged'>;
/** What the reaction tray reads: the ClientGame, or LocalReactions at a table with no server. */
type ReactionPort = Pick<ClientGame, 'localSeat' | 'canReact' | 'reactionCooldownRemaining' | 'sendReaction'>;

export function netTableChrome(ctx: AppContext, service: NetService): TableChrome {
  return (host, layer) => {
    const slots = chromeSlots(layer);
    const chat = new ChatView(slots, host.audio);
    const reactions = new ReactionView(slots, host.audio, () => chat.close());
    chat.onOpen = () => reactions.close();
    const lobby = new LobbyView(slots, host.audio);
    const invite = new InviteView(slots, host.audio, () => {
      chat.close();
      reactions.close();
    });
    const verify = new VerifyView(slots, ctx);
    const banner = v2tEl('div', 'v2t-status-pill', slots.layer);
    banner.innerHTML = '<i class="v2t-spin" aria-hidden="true"></i><span>Reconnecting…</span>';
    banner.setAttribute('role', 'status');
    banner.hidden = true;
    // Voice: one clear button in the top bar (the seat's small mic badge does the same).
    const micHolder: MicHolder = { session: null, click: () => undefined };
    const micBtn = iconButton(slots.right, 'micOff', 'Turn on your microphone', () => micHolder.click(), 0);
    micBtn.hidden = true;

    let session: NetTableSession | null = null;
    /** Chat and reactions for a table with no server (made on first need, kept for this visit). */
    let local: { chat: LocalChat; reactions: LocalReactions } | null = null;
    let offGame: (() => void) | null = null;
    let boundGame: ClientGame | null = null;
    let boundSide: ChatPort | null = null;
    const bind = (s: NetTableSession | null) => {
      if (s === session && s?.game === boundGame) {
        refresh();
        return;
      }
      offGame?.();
      offGame = null;
      session = s;
      boundGame = s?.game ?? null;
      if (!s?.game) {
        micBtn.hidden = true;
        micHolder.session = null;
      }
      chat.bind(s?.chat ?? local?.chat ?? null);
      if (s?.game) {
        const game = s.game;
        offGame = game.onChange((what) => {
          if (what === 'joinError') showJoinError(game);
          refresh();
        });
        s.game.privateBuyInPrompt = (g) => openPrivateBuyIn(slots, g, service, ctx);
        service.privateBuyInPrompt = s.game.privateBuyInPrompt;
        bindSeatMic(s, slots.layer, micBtn, micHolder);
      }
      refresh();
    };

    // A sit-down that failed must reach the player (table messages aren't drawn): a v2 dialog via the host's
    // message box (the global v2 dialog layer), else a toast.
    const showJoinError = (game: ClientGame) => {
      const err = game.joinError;
      game.joinError = null;
      if (!err) return;
      const nomad = ctx.services.nomad;
      if (nomad) nomad.message(err.title, err.message);
      else tableToast(slots.layer, err.message);
    };

    const refresh = () => {
      // A table with its own side channel (on-chain tables): its chat and reactions.
      const side = !session ? (host.session?.sideChannel as { chat: ChatPort; reactions: ReactionPort } | null | undefined) : null;
      if (side) {
        if (boundSide !== side.chat) {
          boundSide = side.chat;
          chat.bind(side.chat as TableChat);
        }
        chat.setLive(true);
        reactions.render(side.reactions);
        lobby.render(null);
        invite.render(null);
        chat.render();
        banner.hidden = true;
        return;
      }
      if (!session && host.session?.localPlayerSeated) {
        if (!local) {
          local = { chat: new LocalChat(() => service.identity.playerName), reactions: new LocalReactions(host) };
          chat.bind(local.chat);
        }
        chat.setLive(true);
        reactions.render(local.reactions);
        lobby.render(null);
        invite.render(null);
        chat.render();
        banner.hidden = true;
        return;
      }
      const g = session?.game ?? null;
      const live = !!session && session.status !== 'closed';
      chat.setLive(live);
      reactions.render(live ? g : null);
      lobby.render(live ? g : null);
      invite.render(live ? g : null);
      verify.render(session);
      chat.render();
      banner.hidden = session?.status !== 'reconnecting';
    };

    const offSession = ctx.events.on<NetTableSession | null>('net:session', (s) => bind(s ?? null));
    const tick = window.setInterval(() => {
      // SeatActionButtons / reaction panel poll their few bools every frame in Unity.
      if (session) {
        reactions.render(session.status !== 'closed' ? session.game : null);
        lobby.render(session.status !== 'closed' ? session.game : null);
        invite.render(session.status !== 'closed' ? session.game : null);
        verify.render(session);
        chat.render();
      } else refresh(); // no net session (yet): a table with no server, or one still connecting
    }, 200);
    bind(service.current);

    return () => {
      offSession();
      offGame?.();
      window.clearInterval(tick);
      chat.bind(null);
      chat.dispose();
      reactions.dispose();
      local?.reactions.dispose();
      lobby.dispose();
      invite.dispose();
      verify.dispose();
      banner.remove();
      setPregame(false);
    };
  };
}

// ---------------------------------------------------------------------------------------------------- chat

/** Port of Net/Chat/PokerChatPanel.cs as a v2 drawer. */
class ChatView {
  private readonly toggle: HTMLButtonElement;
  private readonly badge: HTMLElement;
  private readonly drawer: HTMLElement;
  private readonly status: HTMLElement;
  private readonly logEl: HTMLElement;
  private readonly presets: HTMLButtonElement[] = [];
  private readonly input: HTMLInputElement;
  private readonly sendBtn: HTMLButtonElement;
  /** Live feed: new messages pop up on the right like a stream chat, then fade (tap one to open the chat). */
  private readonly feed: HTMLElement;
  private chat: ChatPort | null = null;
  private off: (() => void)[] = [];
  private open = false;
  private unread = 0;
  private live = false;
  private sendLabel = '';
  onOpen: (() => void) | null = null;
  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.open) {
      e.stopImmediatePropagation();
      this.setOpen(false);
    }
  };

  constructor(slots: ChromeSlots, private readonly audio: Audio) {
    const f = fieldsOf(child('Chat_Panel'));
    this.toggle = iconButton(slots.right, 'chat', 'Table chat', () => {
      audio.play(PokerSound.ButtonGeneric);
      this.setOpen(!this.open);
    }, 2);
    this.badge = v2tEl('span', 'v2t-dot', this.toggle);
    this.drawer = v2tEl('div', 'v2t-drawer v2t-chat', slots.layer);
    this.drawer.setAttribute('role', 'dialog');
    this.drawer.setAttribute('aria-label', 'Table chat');
    const head = v2tEl('div', 'v2t-drawer-head', this.drawer);
    v2tEl('div', 'v2t-h', head, 'Table chat');
    this.status = v2tEl('small', '', head);
    const x = v2tEl('button', 'v2t-ib sm', head);
    x.type = 'button';
    x.innerHTML = tIcon('close', 0.95);
    x.setAttribute('aria-label', 'Close chat');
    x.addEventListener('click', () => this.setOpen(false));
    this.logEl = v2tEl('div', 'v2t-chat-log', this.drawer);
    this.logEl.setAttribute('aria-live', 'polite');
    const presetRow = v2tEl('div', 'v2t-chat-presets', this.drawer);
    const texts = (f.presetTexts as string[] | undefined) ?? ['Nice hand!', 'Good game', 'Thanks!', 'Nice bluff', 'gl hf'];
    for (const t of texts.slice(0, 5)) {
      const b = v2tEl('button', 'v2t-pchip', presetRow, t);
      b.type = 'button';
      b.addEventListener('click', () => {
        audio.play(PokerSound.ButtonGeneric);
        this.sendText(t);
      });
      this.presets.push(b);
    }
    const inRow = v2tEl('div', 'v2t-chat-in', this.drawer);
    this.input = v2tEl('input', '', inRow);
    this.input.maxLength = PokerChatText.MaxLength;
    this.input.placeholder = 'Say something…';
    this.input.setAttribute('aria-label', 'Chat message');
    this.input.autocomplete = 'off';
    this.sendBtn = v2tEl('button', 'v2t-b blue', inRow);
    this.sendBtn.type = 'button';
    this.sendBtn.addEventListener('click', () => {
      audio.play(PokerSound.ButtonGeneric);
      this.sendFromInput();
    });
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // the betting panel's hotkeys stand down while typing (PokerTableChat.IsTyping)
      if (e.key === 'Enter') this.sendFromInput();
      if (e.key === 'Escape') this.setOpen(false);
    });
    this.input.addEventListener('keyup', (e) => e.stopPropagation());
    this.input.addEventListener('focus', () => (TableChat.isTyping = true));
    this.input.addEventListener('blur', () => (TableChat.isTyping = false));
    this.feed = v2tEl('div', 'v2t-chat-feed', slots.layer);
    this.feed.setAttribute('aria-hidden', 'true'); // the drawer's log is the accessible record
    window.addEventListener('keydown', this.onKey, true);
    this.setOpen(false); // startCollapsed
  }

  /** Pops one message into the feed (closed drawer only); the oldest drops off past FEED_MAX. */
  private pushFeed(row: PokerChatRow): void {
    if (this.open || !this.live) return;
    const item = v2tEl('button', 'v2t-feed-item', this.feed);
    item.type = 'button';
    item.tabIndex = -1;
    const name = v2tEl('b', '', item, row.name); // text nodes only: never markup
    name.style.color = row.isLocal ? 'var(--v2-mut)' : NAME_COLORS[row.colorIndex % NAME_COLORS.length]!;
    item.append(document.createTextNode(row.body));
    item.addEventListener('click', () => {
      this.audio.play(PokerSound.ButtonGeneric);
      this.setOpen(true);
    });
    while (this.feed.childElementCount > FEED_MAX) this.feed.firstElementChild?.remove();
    // Fades out after FEED_SECONDS (CSS animation), then leaves the DOM.
    window.setTimeout(() => {
      item.classList.add('out');
      window.setTimeout(() => item.remove(), 450);
    }, FEED_SECONDS * 1000);
  }

  get isOpen(): boolean {
    return this.open;
  }

  close(): void {
    if (this.open) this.setOpen(false);
  }

  setLive(on: boolean): void {
    this.live = on;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey, true);
    TableChat.isTyping = false;
    this.toggle.remove();
    this.drawer.remove();
    this.feed.remove();
  }

  bind(chat: ChatPort | null): void {
    for (const f of this.off.splice(0)) f();
    this.chat = chat;
    this.unread = 0;
    if (chat) {
      const added = (row: PokerChatRow) => this.onMessageAdded(row);
      const cleared = () => {
        this.unread = 0;
        this.rebuild();
      };
      const state = () => this.render();
      chat.messageAdded.add(added);
      chat.logCleared.add(cleared);
      chat.stateChanged.add(state);
      this.off.push(() => chat.messageAdded.delete(added), () => chat.logCleared.delete(cleared), () => chat.stateChanged.delete(state));
    }
    this.rebuild();
    this.render();
  }

  private setOpen(open: boolean): void {
    this.open = open;
    if (open) {
      this.unread = 0;
      this.onOpen?.();
    }
    this.drawer.hidden = !open;
    this.feed.hidden = open; // the full log replaces the feed while the drawer is open
    if (open) this.feed.replaceChildren();
    this.toggle.classList.toggle('on', open);
    this.toggle.setAttribute('aria-expanded', String(open));
    this.renderUnread();
    if (open) this.scrollToBottom();
    else this.input.blur();
  }

  private sendFromInput(): void {
    if (this.sendText(this.input.value)) {
      this.input.value = '';
      this.input.focus();
    }
  }

  private sendText(body: string): boolean {
    if (!this.chat) return false;
    const sent = this.chat.send(body);
    if (sent) this.scrollToBottom();
    this.render();
    return sent;
  }

  private onMessageAdded(row: PokerChatRow): void {
    if (!row.isLocal) this.audio.play(PokerSound.ChatMessage);
    this.pushFeed(row);
    const atBottom = this.logEl.scrollTop + this.logEl.clientHeight >= this.logEl.scrollHeight - 4;
    this.rebuild();
    if (row.isLocal || (this.open && atBottom)) this.scrollToBottom();
    else if (!row.isLocal && !this.open) {
      this.unread++;
      this.renderUnread();
    }
  }

  private rebuild(): void {
    this.logEl.replaceChildren();
    const log = this.chat?.log ?? [];
    if (!log.length) {
      v2tEl('div', 'v2t-chat-empty', this.logEl, 'No messages yet. Say hi, or tap a quick message.');
      return;
    }
    for (const row of log) {
      const el = v2tEl('div', 'v2t-chat-row', this.logEl);
      const name = v2tEl('b', '', el, row.name); // <noparse>: never markup
      name.style.color = row.isLocal ? 'var(--v2-mut)' : NAME_COLORS[row.colorIndex % NAME_COLORS.length]!;
      el.append(document.createTextNode(row.body));
    }
  }

  private scrollToBottom(): void {
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  render(): void {
    const c = this.chat;
    const available = this.live && (!c || c.isAvailable);
    this.toggle.hidden = !available;
    if (!available && this.open) this.setOpen(false);
    const state = c?.state;
    this.status.textContent = c instanceof LocalChat ? 'Offline'
      : state === ChatLinkState.Connecting || state === ChatLinkState.Subscribing ? 'Connecting…' : state === ChatLinkState.Retrying ? 'Reconnecting…' : state === ChatLinkState.Unavailable ? 'Offline' : '';
    this.renderUnread();
    const canSend = !!c && c.canSend;
    this.sendBtn.disabled = !canSend;
    for (const b of this.presets) b.disabled = !canSend;
    const wait = c?.sendCooldownRemaining ?? 0;
    const label = !canSend && wait > 0.05 ? `${Math.ceil(wait)}s` : `${tIcon('send', 1)}<span>Send</span>`;
    if (label !== this.sendLabel) this.sendBtn.innerHTML = this.sendLabel = label;
  }

  private renderUnread(): void {
    const show = !this.open && this.unread > 0;
    this.badge.hidden = !show;
    this.badge.textContent = this.unread > 9 ? '9+' : String(this.unread);
  }
}

// ---------------------------------------------------------------------------------------------------- reactions

/** Port of Net/PokerReactionPanel.cs as a v2 tray (the whole ReactionLibrary, closeAfterSend, cooldown). */
class ReactionView {
  private readonly toggle: HTMLButtonElement;
  private readonly tray: HTMLElement;
  private readonly status: HTMLElement;
  private readonly buttons: HTMLButtonElement[] = [];
  private open = false;
  private game: ReactionPort | null = null;
  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.open) {
      e.stopImmediatePropagation();
      this.setOpen(false);
    }
  };

  constructor(slots: ChromeSlots, audio: Audio, private readonly onOpen: () => void) {
    this.toggle = iconButton(slots.right, 'smile', 'Reactions', () => {
      audio.play(PokerSound.ButtonGeneric);
      this.setOpen(!this.open);
    }, 1);
    this.tray = v2tEl('div', 'v2t-drawer v2t-reactions', slots.layer);
    this.tray.setAttribute('role', 'dialog');
    this.tray.setAttribute('aria-label', 'Reactions');
    const head = v2tEl('div', 'v2t-drawer-head', this.tray);
    v2tEl('div', 'v2t-h', head, 'Reactions');
    this.status = v2tEl('small', '', head);
    const x = v2tEl('button', 'v2t-ib sm', head);
    x.type = 'button';
    x.innerHTML = tIcon('close', 0.95);
    x.setAttribute('aria-label', 'Close reactions');
    x.addEventListener('click', () => this.setOpen(false));
    const grid = v2tEl('div', 'v2t-react-grid', this.tray);
    for (const entry of REACTIONS.entries) {
      const sprite = HUD_DATA.sprites[entry.sprite];
      if (!sprite?.file) continue;
      const b = v2tEl('button', 'v2t-react', grid);
      b.type = 'button';
      b.setAttribute('aria-label', `Reaction ${entry.id}`);
      const img = v2tEl('img', '', b);
      img.src = assetUrl(sprite.file);
      img.alt = '';
      // Eager: the same files draw the reaction bubbles over the seats, so they are cached before anyone reacts.
      img.loading = 'eager';
      b.addEventListener('click', () => {
        audio.play(PokerSound.ButtonGeneric);
        if (this.game?.sendReaction(entry.id)) this.setOpen(false); // closeAfterSend
      });
      this.buttons.push(b);
    }
    window.addEventListener('keydown', this.onKey, true);
    this.setOpen(false);
  }

  close(): void {
    if (this.open) this.setOpen(false);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey, true);
    this.toggle.remove();
    this.tray.remove();
  }

  private setOpen(open: boolean): void {
    this.open = open && !!this.game;
    if (this.open) this.onOpen();
    this.tray.hidden = !this.open;
    this.toggle.classList.toggle('on', this.open);
    this.toggle.setAttribute('aria-expanded', String(this.open));
  }

  render(game: ReactionPort | null): void {
    this.game = game;
    const usable = !!game && game.localSeat >= 0;
    this.toggle.hidden = !usable;
    if (!usable) {
      if (this.open) this.setOpen(false);
      return;
    }
    const can = game!.canReact;
    for (const b of this.buttons) b.disabled = !can;
    const cd = game!.reactionCooldownRemaining;
    this.status.textContent = cd > 0 ? `Wait ${Math.ceil(cd)}s` : '';
  }
}

// ---------------------------------------------------------------------------------------------------- no server

/**
 * TableChat's surface for a table with no server (offline, practice tournament): nobody else is there, so a message
 * goes straight into your own log. Same sanitising, 10 s duplicate drop, rate limit and log cap as the socket chat.
 */
class LocalChat implements ChatPort {
  private readonly limiter = new PokerChatRateLimiter();
  private readonly rows: PokerChatRow[] = [];
  private lastSentBody: string | null = null;
  private lastSentAt = -Infinity;
  readonly state = ChatLinkState.Subscribed;
  readonly isAvailable = true;
  readonly messageAdded = new Set<(row: PokerChatRow) => void>();
  readonly stateChanged = new Set<() => void>();
  readonly logCleared = new Set<() => void>();

  constructor(private readonly displayName: () => string) {}

  get canSend(): boolean {
    return this.limiter.secondsUntilNextToken(nowSeconds()) <= 0;
  }

  get sendCooldownRemaining(): number {
    return this.limiter.secondsUntilNextToken(nowSeconds());
  }

  get log(): readonly PokerChatRow[] {
    return this.rows;
  }

  send(body: string): boolean {
    const clean = PokerChatText.sanitize(body);
    if (!clean) return false;
    const t = nowSeconds();
    if (clean === this.lastSentBody && t - this.lastSentAt < 10) return false;
    if (!this.limiter.tryConsume(t)) return false;
    this.lastSentBody = clean;
    this.lastSentAt = t;
    const [name] = PokerChatText.encode(this.displayName() || 'You', clean);
    const row: PokerChatRow = { userId: 'local', name, body: clean, isLocal: true, colorIndex: 0 };
    this.rows.push(row);
    while (this.rows.length > PokerChatSettings.LogCapacity) this.rows.shift();
    for (const fn of [...this.messageAdded]) fn(row);
    for (const fn of [...this.stateChanged]) fn();
    return true;
  }
}

/**
 * Reactions at a table with no server: your reaction pops over your own seat (the near HUD slot, where the offline
 * engine and the practice tournament draw you), with the net table's bubble and cooldown.
 */
class LocalReactions implements ReactionPort {
  private readonly limiter = new PokerChatRateLimiter(4, 1.5); // ClientGame.reactionLimiter
  private readonly bubbles = new ReactionBubbles();

  constructor(private readonly host: TableSessionHost) {}

  get localSeat(): number {
    return this.host.session?.localPlayerSeated?.() ? LOCAL_PERSPECTIVE_SLOT : -1;
  }

  get canReact(): boolean {
    return this.localSeat >= 0 && this.limiter.secondsUntilNextToken(nowSeconds()) <= 0;
  }

  get reactionCooldownRemaining(): number {
    return this.limiter.secondsUntilNextToken(nowSeconds());
  }

  sendReaction(reactionId: number): boolean {
    if (this.localSeat < 0) return false;
    const hud = this.host.stage.hud.seats[LOCAL_PERSPECTIVE_SLOT];
    if (!hud?.visible || !this.limiter.tryConsume(nowSeconds())) return false;
    return this.bubbles.show(LOCAL_PERSPECTIVE_SLOT, hud, reactionId & 0xff);
  }

  dispose(): void {
    this.bubbles.dispose();
  }
}

// ---------------------------------------------------------------------------------------------------- join / lobby

/** html.v2t-pregame: hides the betting action row in landscape while the pre-game buttons are up (ui2/table.css). */
function setPregame(on: boolean): void {
  if (typeof document !== 'undefined') document.documentElement.classList.toggle('v2t-pregame', on);
}

/** SeatActionButtons (Join table) + PokerLobbyView (Start game / Play again, + Add Bot, the room code). */
class LobbyView {
  private readonly row: HTMLElement;
  private readonly wrap: HTMLElement;
  private readonly caption: HTMLElement;
  private readonly join: HTMLButtonElement;
  private readonly start: HTMLButtonElement;
  private readonly addBot: HTMLButtonElement;
  private readonly botChip: HTMLButtonElement;
  private readonly code: HTMLButtonElement;
  private game: ClientGame | null = null;
  private announcedWatch: ClientGame | null = null;

  constructor(private readonly slots: ChromeSlots, audio: Audio) {
    const click = (fn: () => void) => () => {
      audio.play(PokerSound.ButtonGeneric);
      fn();
    };
    this.wrap = v2tEl('div', '', slots.pregame);
    this.wrap.style.display = 'contents';
    this.row = v2tEl('div', 'v2t-pgrow-in', this.wrap);
    this.addBot = v2tEl('button', 'v2t-b violet', this.row);
    this.addBot.type = 'button';
    this.addBot.innerHTML = `${tIcon('bot', 1.2)}<span>Add bot</span>`;
    this.addBot.addEventListener('click', click(() => this.game?.requestAddBot()));
    this.join = v2tEl('button', 'v2t-b gold lg', this.row, 'Join table');
    this.join.type = 'button';
    this.join.addEventListener('click', click(() => this.game?.requestJoinTable()));
    this.start = v2tEl('button', 'v2t-b gold lg', this.row, 'Start game');
    this.start.type = 'button';
    this.start.addEventListener('click', click(() => this.game?.requestStartGame()));
    this.caption = v2tEl('div', 'v2t-cap', this.wrap);
    // During a hand + Add Bot stays reachable as a small chip under Leave.
    this.botChip = chipButton(slots.left2, `${tIcon('bot', 1.1)}<span>Add bot</span>`, 'Add a bot', click(() => this.game?.requestAddBot()), 'bot', 2);
    this.code = chipButton(slots.left, '', 'Room code', click(() => this.copyCode()), 'code', 1);
  }

  dispose(): void {
    this.wrap.remove();
    this.botChip.remove();
    this.code.remove();
  }

  private copyCode(): void {
    const code = this.game?.roomCode;
    if (!code || StakeSessionNames.isPool(code)) return;
    void navigator.clipboard?.writeText(code).then(
      () => tableToast(this.slots.layer, 'Room code copied'),
      () => tableToast(this.slots.layer, `Room code ${code}`),
    );
  }

  render(game: ClientGame | null): void {
    this.game = game;
    const lobby = game?.lobby ?? null;
    if (!game || !lobby) {
      for (const n of [this.join, this.start, this.addBot, this.botChip, this.code]) n.hidden = true;
      this.caption.hidden = true;
      setPregame(false);
      return;
    }
    // SeatActionButtons.Refresh
    const joining = game.isJoining;
    const watching = game.isWatching;
    if (watching && this.announcedWatch !== game) {
      this.announcedWatch = game;
      tableToast(this.slots.layer, "You're watching. Players' cards stay hidden until a showdown.");
    }
    const seatOffered = !watching && ((game.localSeat < 0 && (lobby.youCanBuyIn || game.isPrivateTable)) || joining);
    this.join.hidden = !seatOffered;
    this.join.disabled = !game.canJoinTable || joining;
    this.join.textContent = joining ? 'Joining…' : 'Join table';

    // PokerLobbyView.SetVisible / Render
    const owner = lobby.youAreOwner && !watching;
    const playing = lobby.phase === TablePhase.Playing;
    const showBots = owner && !game.isMoneyTable && !lobby.autoStart;
    const freeSeat = (game.roster ?? []).some((s) => !s.isOccupied);
    const startShown = owner && !playing && !lobby.autoStart && !joining && !seatOffered;
    this.start.hidden = !startShown;
    const enough = lobby.seatedCount >= lobby.minToStart && lobby.readyCount >= lobby.minToStart;
    this.start.disabled = !enough;
    this.start.textContent = lobby.phase === TablePhase.GameOver ? 'Play again' : 'Start game';

    // Pre-game row: [+ Add bot][Join table | Start game], with why Start can't go yet.
    const pregame = !this.join.hidden || startShown;
    this.addBot.hidden = !(showBots && pregame && !seatOffered);
    this.addBot.disabled = !freeSeat;
    this.botChip.hidden = !(showBots && !pregame && playing);
    this.botChip.disabled = !freeSeat;
    const need = Math.max(0, lobby.minToStart - lobby.seatedCount);
    this.caption.hidden = !(startShown && !enough);
    this.caption.textContent = need > 0 ? `Need ${need} more player${need === 1 ? '' : 's'} to start${showBots ? ' · add a bot' : ''}` : 'Waiting for everyone to be ready';
    setPregame(pregame);

    // Phones: the room code sits on the second row (with + Bot) so the top row fits Leave and the icons.
    const codeSlot = isPortrait() ? this.slots.left2 : this.slots.left;
    if (this.code.parentElement !== codeSlot) codeSlot.append(this.code);

    // SetRoomCode: the party code (tap to copy). A shared Quick Play pool has no code worth showing: the chip used to
    // say "Quick Play" as a disabled button, which read as a broken control, so it is hidden there.
    const code = game.roomCode;
    const shared = StakeSessionNames.isPool(code);
    this.code.hidden = shared || !(code.length > 0 && !game.isTournament);
    this.code.classList.toggle('static', shared);
    this.code.disabled = shared;
    const html = shared ? '<span>Quick Play</span>' : `<small>CODE</small><span>${code.replace(/[<&>]/g, '')}</span>${tIcon('copy', 1.1)}`;
    if (this.code.dataset.html !== html) {
      this.code.dataset.html = html;
      this.code.innerHTML = html;
      this.code.setAttribute('aria-label', shared ? 'Quick Play table' : `Room code ${code}, tap to copy`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------- invite friends

/**
 * "Invite" at a private (party) table: a drawer of your friends, online first, each with an Invite button. The invite
 * lands in their Friends list ("Invited you to a table" → Join); sharing the room code still works alongside it.
 */
class InviteView {
  private readonly chip: HTMLButtonElement;
  private readonly tray: HTMLElement;
  private readonly list: HTMLElement;
  private readonly sent = new Set<string>();
  private open = false;
  private game: ClientGame | null = null;
  private readonly offChanged: () => void;

  constructor(
    private readonly slots: ChromeSlots,
    private readonly audio: Audio,
    private readonly onOpen: () => void,
  ) {
    this.chip = chipButton(slots.left, `${tIcon('friends', 1.1)}<span>Invite</span>`, 'Invite friends to this table', () => {
      audio.play(PokerSound.ButtonGeneric);
      this.setOpen(!this.open);
    }, 'invite', 1);
    this.tray = v2tEl('div', 'v2t-drawer v2t-invite', slots.layer);
    this.tray.setAttribute('role', 'dialog');
    this.tray.setAttribute('aria-label', 'Invite friends');
    const head = v2tEl('div', 'v2t-drawer-head', this.tray);
    v2tEl('div', 'v2t-h', head, 'Invite friends');
    const x = v2tEl('button', 'v2t-ib sm', head);
    x.type = 'button';
    x.innerHTML = tIcon('close', 0.95);
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', () => this.setOpen(false));
    v2tEl('small', 'v2t-invite-note', this.tray, 'They get it in their Friends list and can join with one tap.');
    this.list = v2tEl('div', 'v2t-invite-list', this.tray);
    this.offChanged = Friends.changed.on(() => {
      if (this.open) this.paint();
    });
    this.setOpen(false);
  }

  dispose(): void {
    this.offChanged();
    this.chip.remove();
    this.tray.remove();
  }

  close(): void {
    if (this.open) this.setOpen(false);
  }

  private setOpen(open: boolean): void {
    this.open = open && !!this.game;
    if (this.open) {
      this.onOpen();
      this.paint();
      void Friends.refreshAsync().then(() => {
        if (this.open) this.paint();
      });
    }
    this.tray.hidden = !this.open;
    this.chip.classList.toggle('on', this.open);
  }

  private paint(): void {
    const online = (f: FriendEntry): boolean => f.online === true;
    const friends = Friends.all
      .filter((f) => f.relation === FriendRelation.Friend)
      .sort((a, b) => Number(online(b)) - Number(online(a)) || friendLabel(a).localeCompare(friendLabel(b)));
    this.list.textContent = '';
    if (!friends.length) {
      v2tEl('div', 'v2t-chat-empty', this.list, 'No friends yet. Add them from Friends on the main menu, or share the room code.');
      return;
    }
    for (const f of friends) {
      const row = v2tEl('div', 'v2t-invite-row', this.list);
      const name = v2tEl('div', 'v2t-invite-name', row);
      v2tEl('b', '', name, friendLabel(f));
      v2tEl('small', online(f) ? 'on' : '', name, online(f) ? 'Online' : 'Offline');
      const b = v2tEl('button', 'v2t-b sm', row, this.sent.has(f.id) ? 'Invited' : 'Invite');
      b.type = 'button';
      b.disabled = this.sent.has(f.id);
      b.addEventListener('click', () => {
        this.audio.play(PokerSound.ButtonGeneric);
        b.disabled = true;
        b.textContent = 'Sending…';
        void FriendInvites.inviteAsync(f).then((res) => {
          if (res.success) {
            this.sent.add(f.id);
            b.textContent = 'Invited';
          } else {
            b.disabled = false;
            b.textContent = 'Invite';
            tableToast(this.slots.layer, res.error ?? "Couldn't send the invite");
          }
        });
      });
    }
  }

  render(game: ClientGame | null): void {
    this.game = game;
    const code = game?.roomCode ?? '';
    // Private party tables only (a pool has no code and is joined from Friends directly), signed in, not a tournament
    // or a real-money table.
    const usable =
      !!game && game.isPrivateTable && !game.isTournament && !game.isMoneyTable && code.length > 0 && !StakeSessionNames.isPool(code) && NomadLink.signedIn;
    this.chip.hidden = !usable;
    const slot = isPortrait() ? this.slots.left2 : this.slots.left;
    if (this.chip.parentElement !== slot) slot.append(this.chip);
    if (!usable && this.open) this.setOpen(false);
  }
}

// ---------------------------------------------------------------------------------------------------- private buy-in

/**
 * PrivateBuyInPrompt.Open: 500–1,000 table chips from the Coin balance (blinds 5 / 10). The prompt itself is the web3
 * module's 'private-buy-in' screen (Net/PrivateBuyInPrompt.cs); this keeps a v2 sheet as the fallback for a build
 * without it. It closes itself once the seat is taken.
 */
function openPrivateBuyIn(slots: ChromeSlots, game: ClientGame, service: NetService, ctx: AppContext): void {
  if (ctx.router.has('private-buy-in')) {
    const off = game.onChange((w) => {
      if (w === 'seat' && game.localSeat >= 0) {
        off();
        if (ctx.router.current === 'private-buy-in') ctx.router.back();
      }
    });
    void ctx.router.push('private-buy-in', {
      coins: service.wallet.coins,
      onConfirm: (amount: number) => {
        off();
        game.confirmPrivateBuyIn(amount);
      },
      onCancel: () => off(),
    });
    return;
  }
  openSheetPrivateBuyIn(slots, game, service);
}

function openSheetPrivateBuyIn(slots: ChromeSlots, game: ClientGame, service: NetService): void {
  const coins = service.wallet.coins;
  const min = ChainTableMode.PrivateMinBuyIn;
  const max = Math.min(ChainTableMode.PrivateMaxBuyIn, coins);
  const canAfford = coins >= min;
  let off: () => void = () => undefined;
  const { body, foot, close } = tableSheet(slots.layer, 'Buy in', { onClose: () => off() });
  const cap = v2tEl('div', 'v2t-mut', body, `Private table · blinds ${n0(ChainTableMode.PrivateSmallBlind)} / ${n0(ChainTableMode.PrivateBigBlind)} · you have ${n0(coins)} Coins`);
  cap.style.marginBottom = '0.8em';
  let amount = Math.max(min, max);
  const cancel = v2tEl('button', 'v2t-b ghost', foot, 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', close);
  const join = v2tEl('button', 'v2t-b gold', foot);
  join.type = 'button';
  if (!canAfford) {
    v2tEl('p', '', body, `This table needs ${n0(min)}–${n0(ChainTableMode.PrivateMaxBuyIn)} Coins.`);
    join.textContent = 'Not enough Coins';
    join.disabled = true;
  } else {
    const amt = v2tEl('div', 'v2t-buyin-amt', body);
    const range = v2tEl('input', 'v2t-buyin-range', body);
    range.type = 'range';
    range.min = String(min);
    range.max = String(Math.max(min, max));
    range.step = String(ChainTableMode.PrivateBigBlind);
    range.value = String(amount);
    range.disabled = max <= min;
    range.setAttribute('aria-label', 'Buy-in');
    const ends = v2tEl('div', 'v2t-buyin-ends', body);
    const lo = v2tEl('button', 'v2t-pchip', ends, `Min ${n0(min)}`);
    const hi = v2tEl('button', 'v2t-pchip', ends, `Max ${n0(Math.max(min, max))}`);
    const paint = () => {
      amt.textContent = n0(amount);
      join.textContent = `Join · ${n0(amount)}`;
    };
    range.addEventListener('input', () => {
      amount = Number(range.value);
      paint();
    });
    lo.addEventListener('click', () => {
      amount = min;
      range.value = String(amount);
      paint();
    });
    hi.addEventListener('click', () => {
      amount = Math.max(min, max);
      range.value = String(amount);
      paint();
    });
    paint();
    join.addEventListener('click', () => {
      game.confirmPrivateBuyIn(amount);
      close();
    });
  }
  off = game.onChange((w) => {
    if (w === 'seat' && game.localSeat >= 0) close();
  });
}

// ---------------------------------------------------------------------------------------------------- voice

const MIC_COLORS = {
  live: { r: 0.2, g: 0.6, b: 0.35, a: 0.95 },
  muted: { r: 0.6, g: 0.22, b: 0.22, a: 0.95 },
  offline: { r: 0.35, g: 0.35, b: 0.35, a: 0.8 },
};

/** The top-bar voice button's current target (the bound table session). */
interface MicHolder {
  session: NetTableSession | null;
  click: () => void;
}

/**
 * PokerSeatMic on the local seat plus the top-bar voice button: a click turns the mic on (asking the browser once),
 * then mutes / unmutes (or retries a voice link that failed). The button and the seat's circle show the state.
 */
function bindSeatMic(s: NetTableSession, layer: HTMLElement, btn: HTMLButtonElement, holder: MicHolder): void {
  const voice = s.voice;
  holder.session = s;
  if (!voice) {
    btn.hidden = true;
    holder.click = () => undefined;
    return;
  }
  const toggle = (): void => {
    if (voice.canRetry) voice.retry();
    else if (!voice.micOn)
      void voice.enableMic().then((ok) => {
        if (!ok) tableToast(layer, 'Microphone blocked: allow it in your browser to talk. You can still hear the table.', 3500);
        else tableToast(layer, 'Microphone on');
      });
    else {
      voice.toggleMute();
      tableToast(layer, voice.isMuted ? 'You are muted' : 'Microphone on');
    }
  };
  holder.click = toggle;
  const paintButton = (): void => {
    if (holder.session !== s) return;
    const joined = voice.state === VoiceLinkState.Joined;
    btn.hidden = s.game.localSeat < 0 || (!joined && !voice.canRetry);
    const live = joined && !voice.isMuted;
    const label = voice.canRetry ? 'Voice unavailable: tap to retry' : !voice.micOn ? 'Turn on your microphone' : voice.isMuted ? 'Unmute' : 'Mute';
    btn.innerHTML = tIcon(live ? 'mic' : 'micOff', 1.35);
    btn.classList.toggle('on', live);
    btn.classList.toggle('mic-muted', joined && voice.micOn && voice.isMuted);
    btn.classList.toggle('mic-off', !joined || voice.micBlocked);
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', String(live));
    btn.title = label;
  };
  const paint = () => {
    paintButton();
    const mic = s.view.micRootForLocal();
    if (!mic) return;
    if (!mic.el.dataset.netMic) {
      mic.el.dataset.netMic = '1';
      mic.el.style.pointerEvents = 'auto';
      mic.el.style.cursor = 'pointer';
      mic.el.title = 'Mute / unmute';
      mic.el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (holder.session === s) toggle();
      });
    }
    const circle = mic.find('Circle');
    if (circle) {
      circle.imageColorOverride = voice.state !== VoiceLinkState.Joined ? MIC_COLORS.offline : voice.isMuted ? MIC_COLORS.muted : MIC_COLORS.live;
      circle.render();
    }
  };
  voice.stateChanged.add(paint);
  s.game.onChange((w) => w === 'seat' && paint());
  paint();
}
