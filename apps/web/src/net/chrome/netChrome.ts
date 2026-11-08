/**
 * The networked table's chrome, registered with addTableChrome and drawn only while a net session is live. Built from
 * the extracted uGUI canvas (unity-hud.json, `Canvas` = the screen HUD) with the same CanvasScaler as the betting
 * panel (Scale With Screen Size 1920×1080, match 0.5):
 *
 *  - Chat_Panel      → PokerChatPanel (toggle + unread badge, log, presets, input, send with cooldown, status)
 *  - Reaction_Panel  → PokerReactionPanel (toggle, tray of the whole ReactionLibrary, cooldown, docked above the chat)
 *  - Join_Table      → SeatActionButtons (Join table / Joining…; Rebuy and Cashout stay hidden on Coins tables)
 *  - Start Game, AddBotButton, InviteButton → PokerLobbyView (owner controls on private rooms, the room code)
 *  - PrivateBuyInPrompt (runtime-built in Unity) → a DOM prompt with the same texts and 500–1,000 slider
 *  - PokerSeatMic on the local seat (voice on only with ?voice=1, as Unity ships voice off)
 *
 * Leaving the table is the menu's Leave / Settings (NomadTableHud) → host.leave() → NetTableSession.stop(), which is
 * TableDisconnectButton's sequence (leave RPC, 0.75 s, shut the runner down).
 */
import type { AppContext } from '../../app/app';
import { PokerSound } from '@nomad/engine/orchestration/pokerSound';
import { TablePhase } from '@nomad/engine/events/pokerEvent';
import { buildNode, HUD_DATA, UNode, whenFontsReady, type NodeData, type RGBA } from '../../hud/unityUi';
import type { TableChrome } from '../../table/tableScreen';
import type { ClientGame } from '../clientGame';
import type { NetService, NetTableSession } from '../netService';
import { PokerChatText } from '@nomad/table-server/chat';
import { ChainTableMode, StakeSessionNames } from '@nomad/table-server/sessions';
import { TableChat, type PokerChatRow } from '../tableChat';
import { VoiceLinkState } from '../voice/tableVoice';
import { applyLayoutGroups, pairNodes } from './uguiLayout';
import './net.css';
import { isPortrait } from '../../layout/orientation';
import { overlayScale } from '../../layout/portraitRects';
import { portraitNetChromeRects } from '../../layout/portraitHud';

const SCREEN = HUD_DATA.canvases.find((c) => c.role === 'screen-hud')!;
const child = (name: string): NodeData | undefined => SCREEN.root.children?.find((c) => c.name === name);
type Fields = Record<string, unknown>;
const fieldsOf = (d: NodeData | undefined): Fields => ((d?.components as { other?: { fields?: Fields }[] } | undefined)?.other?.[0]?.fields ?? {}) as Fields;
const REACTIONS = (HUD_DATA as unknown as { reactions: { entries: { id: number; sprite: string }[] } }).reactions;

function button(n: UNode | null, fn: () => void, sound = true, audio?: { play(s: PokerSound): void }): void {
  if (!n) return;
  n.el.classList.add('net-btn');
  n.el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (n.el.classList.contains('net-disabled')) return;
    if (sound) audio?.play(PokerSound.ButtonGeneric);
    fn();
  });
}

function setInteractable(n: UNode | null, on: boolean): void {
  n?.el.classList.toggle('net-disabled', !on);
}

const css = (c: RGBA) => `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`;

export function netTableChrome(ctx: AppContext, service: NetService): TableChrome {
  return (host, layer) => {
    const holder = document.createElement('div');
    holder.className = 'net-layer';
    layer.append(holder);
    const root = new UNode('NetTableChrome');
    root.el.classList.add('net-canvas');
    holder.append(root.el);

    const chat = new ChatPanelView(root, host.audio);
    const reactions = new ReactionPanelView(root, host.audio);
    const lobby = new LobbyButtonsView(root, host.audio);
    const portrait = portraitNetChromeRects(root);
    const banner = document.createElement('div');
    banner.className = 'net-banner';
    banner.style.display = 'none';
    holder.append(banner);

    const layout = () => {
      const w = holder.clientWidth || window.innerWidth;
      const h = holder.clientHeight || window.innerHeight;
      if (!(w > 0 && h > 0)) return; // zero-size viewport (hidden tab / pane): the scale would be 0 and w / s NaN; the next resize lays out
      const s = overlayScale(w, h); // portrait: everything in the top row (layout/portraitHud.ts)
      root.sizeDelta = [w / s, h / s];
      root.renderScale = s;
      root.el.style.transform = `scale(${s})`;
      portrait.apply();
      root.layout();
      chat.relayout();
      if (!isPortrait()) reactions.dockTo(chat, s);
    };

    let session: NetTableSession | null = null;
    let offGame: (() => void) | null = null;
    const bind = (s: NetTableSession | null) => {
      if (s === session && s?.game === boundGame) {
        refresh();
        return;
      }
      offGame?.();
      offGame = null;
      session = s;
      boundGame = s?.game ?? null;
      chat.bind(s?.chat ?? null);
      if (s?.game) {
        offGame = s.game.onChange(() => refresh());
        s.game.privateBuyInPrompt = (g) => openPrivateBuyIn(holder, g, service, ctx);
        service.privateBuyInPrompt = s.game.privateBuyInPrompt;
        bindSeatMic(s);
      }
      refresh();
    };
    let boundGame: ClientGame | null = null;

    const refresh = () => {
      const g = session?.game ?? null;
      const live = !!session && session.status !== 'closed';
      root.setActive(live);
      reactions.render(g);
      lobby.render(g);
      chat.render();
      banner.style.display = session?.status === 'reconnecting' ? '' : 'none';
      banner.textContent = 'Reconnecting…';
      layout();
    };

    const offSession = ctx.events.on<NetTableSession | null>('net:session', (s) => bind(s ?? null));
    const tick = window.setInterval(() => {
      // SeatActionButtons / reaction panel poll their few bools every frame in Unity.
      if (session) {
        reactions.render(session.game);
        lobby.render(session.game);
        chat.render();
      }
    }, 200);
    window.addEventListener('resize', layout);
    whenFontsReady([root]);
    bind(service.current);

    return () => {
      offSession();
      offGame?.();
      window.clearInterval(tick);
      window.removeEventListener('resize', layout);
      chat.bind(null);
      holder.remove();
    };
  };
}

// ---------------------------------------------------------------------------------------------------- chat

/** Port of Net/Chat/PokerChatPanel.cs over the extracted Chat_Panel. */
class ChatPanelView {
  readonly root: UNode;
  readonly toggle: UNode;
  readonly window: UNode;
  private readonly unreadBadge: UNode | null;
  private readonly unreadLabel: UNode | null;
  private readonly statusLabel: UNode | null;
  private readonly sendButton: UNode | null;
  private readonly sendLabel: UNode | null;
  private readonly presets: UNode[] = [];
  private readonly logEl = document.createElement('div');
  private readonly input = document.createElement('input');
  private readonly pairs;
  private chat: TableChat | null = null;
  private off: (() => void)[] = [];
  private open = false;
  private unread = 0;
  private readonly palette: RGBA[];
  private readonly bodyColor: string;

  constructor(parent: UNode, private readonly audio: { play(s: PokerSound): void }) {
    const data = child('Chat_Panel')!;
    const f = fieldsOf(data);
    this.root = parent.add(buildNode({ ...data, active: true }));
    this.pairs = pairNodes(this.root, data);
    this.toggle = this.root.find('Chat_Toggle')!;
    this.window = this.root.find('Chat_Window')!;
    this.unreadBadge = this.root.find('Chat_Toggle/Unread_Badge');
    this.unreadLabel = this.root.find('Chat_Toggle/Unread_Badge/Unread_Label');
    this.statusLabel = this.root.find('Chat_Window/Header/Status_Label');
    this.sendButton = this.root.find('Chat_Window/Input_Row/Send_Button');
    this.sendLabel = this.root.find('Chat_Window/Input_Row/Send_Button/Send_Label');
    this.palette = ((f.senderPalette as { r: string; g: string; b: string; a: string }[] | undefined) ?? []).map((c) => ({ r: +c.r, g: +c.g, b: +c.b, a: +c.a }));
    // MessageBodyColor = ThemeManager.LabelColor — the themed input text colour.
    const inputText = this.root.find('Chat_Window/Input_Row/Chat_Input/Text_Area/Text');
    this.bodyColor = inputText?.text ? css(inputText.text.color) : '#2b7bae';

    button(this.toggle, () => this.setOpen(!this.open), true, audio);
    button(this.root.find('Chat_Window/Header/Close_Button'), () => this.setOpen(false), true, audio);
    button(this.sendButton, () => this.sendFromInput(), true, audio);

    const texts = (f.presetTexts as string[] | undefined) ?? ['Nice hand!', 'Good game', 'Thanks!', 'Nice bluff', 'gl hf'];
    const row = this.root.find('Chat_Window/Presets_Row');
    row?.children.forEach((b, i) => {
      const text = texts[i];
      if (!text) {
        b.setActive(false);
        return;
      }
      b.children.find((c) => c.text)?.setText(text);
      this.presets.push(b);
      button(b, () => this.sendText(text), true, audio);
    });

    // Log: TMP rows under Log_Scroll/Viewport/Content, drawn as DOM (rich text, wrapping, scrolling).
    const viewport = this.root.find('Chat_Window/Log_Scroll/Viewport');
    this.logEl.className = 'net-chat-log';
    viewport?.el.append(this.logEl);
    this.root.find('Chat_Window/Log_Scroll/Viewport/Content')?.setActive(false);

    // TMP_InputField: a real input over Text_Area, with the placeholder text.
    const area = this.root.find('Chat_Window/Input_Row/Chat_Input/Text_Area');
    const placeholder = area?.find('Placeholder');
    this.input.className = 'net-chat-input';
    this.input.maxLength = PokerChatText.MaxLength;
    this.input.placeholder = placeholder?.text?.text ?? 'Say something…';
    this.input.style.color = this.bodyColor;
    placeholder?.setActive(false);
    area?.find('Text')?.setActive(false);
    area?.el.append(this.input);
    if (area) area.el.style.pointerEvents = 'auto';
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // the betting panel's hotkeys stand down while typing (PokerTableChat.IsTyping)
      if (e.key === 'Enter') this.sendFromInput();
    });
    this.input.addEventListener('keyup', (e) => e.stopPropagation());
    this.input.addEventListener('focus', () => (TableChat.isTyping = true));
    this.input.addEventListener('blur', () => (TableChat.isTyping = false));
    for (const n of [this.window, this.toggle]) n.el.classList.add('net-hit');

    // startCollapsed, and always collapsed on a narrow screen.
    this.setOpen(false);
  }

  get isOpen(): boolean {
    return this.open;
  }

  relayout(): void {
    applyLayoutGroups(this.root, this.pairs);
  }

  bind(chat: TableChat | null): void {
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
    if (open) this.unread = 0;
    this.window.setActive(open);
    this.renderUnread();
    if (open) {
      this.relayout();
      this.scrollToBottom();
    }
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
    const atBottom = this.logEl.scrollTop + this.logEl.clientHeight >= this.logEl.scrollHeight - 4;
    this.rebuild();
    if (row.isLocal || (this.open && atBottom)) this.scrollToBottom();
    else if (!row.isLocal) {
      this.unread++;
      this.renderUnread();
    }
  }

  private rebuild(): void {
    this.logEl.replaceChildren();
    for (const row of this.chat?.log ?? []) {
      const el = document.createElement('div');
      el.className = 'net-chat-row';
      const name = document.createElement('span');
      name.className = 'net-chat-name';
      name.textContent = row.name;
      name.style.color = row.isLocal || this.palette.length === 0 ? this.bodyColor : css(this.palette[row.colorIndex % this.palette.length]!);
      const body = document.createElement('span');
      body.textContent = '  ' + row.body; // <noparse>: never markup
      body.style.color = this.bodyColor;
      el.append(name, body);
      this.logEl.append(el);
    }
  }

  private scrollToBottom(): void {
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  render(): void {
    const c = this.chat;
    const available = !c || c.isAvailable;
    this.root.setActive(available);
    const state = c?.state;
    const status = state === undefined ? '' : ['', 'Connecting…', 'Connecting…', '', 'Reconnecting…', 'Chat offline'][state] ?? '';
    this.statusLabel?.setText(status);
    this.statusLabel?.setActive(!!status);
    this.renderUnread();
    const canSend = !!c && c.canSend;
    setInteractable(this.sendButton, canSend);
    for (const b of this.presets) setInteractable(b, canSend);
    const wait = c?.sendCooldownRemaining ?? 0;
    this.sendLabel?.setText(!canSend && wait > 0.05 ? `${Math.ceil(wait)}s` : 'Send');
  }

  private renderUnread(): void {
    const show = !this.open && this.unread > 0;
    this.unreadBadge?.setActive(show);
    this.unreadLabel?.setText(this.unread > 9 ? '9+' : String(this.unread));
  }
}

// ---------------------------------------------------------------------------------------------------- reactions

/** Port of Net/PokerReactionPanel.cs over the extracted Reaction_Panel. */
class ReactionPanelView {
  readonly root: UNode;
  private readonly toggle: UNode;
  private readonly tray: UNode;
  private readonly status: UNode | null;
  private readonly buttons: UNode[] = [];
  private readonly pairs;
  private open = false;
  private usable = true;

  constructor(parent: UNode, audio: { play(s: PokerSound): void }) {
    const data = child('Reaction_Panel')!;
    this.root = parent.add(buildNode({ ...data, active: true }));
    this.toggle = this.root.find('Reaction_Toggle')!;
    this.tray = this.root.find('Reaction_Tray')!;
    this.status = this.root.find('Reaction_Tray/Reaction_Status');
    const gridNode = this.root.find('Reaction_Tray/Viewport/Reaction_Grid')!;
    this.root.find('Reaction_Tray/Viewport')?.el.classList.add('net-reaction-viewport');
    this.root.find('Reaction_Tray/Scrollbar')?.setActive(false); // the DOM viewport scrolls itself

    // showWholeLibrary: every reaction the library holds, cloning the first button for the ones not authored.
    const template = gridNode.children[0]!;
    const templateData = (data.children!.find((c) => c.name === 'Reaction_Tray')!.children!.find((c) => c.name === 'Viewport')!.children![0]!.children![0]!) as NodeData;
    const entries = REACTIONS.entries;
    for (let i = gridNode.children.length; i < entries.length; i++) gridNode.add(buildNode({ ...templateData, name: `Reaction_${i + 1}` }));
    void template;
    gridNode.children.forEach((b, i) => {
      const entry = entries[i];
      if (!entry) {
        b.setActive(false);
        return;
      }
      const icon = b.children[0] ?? b;
      const sprite = HUD_DATA.sprites[entry.sprite];
      if (icon.image && sprite) {
        icon.image.sprite = sprite;
        icon.image.preserveAspect = true;
      }
      this.buttons.push(b);
      button(b, () => this.send(entry.id), true, audio);
    });
    this.pairs = pairNodes(this.root, { ...data, children: data.children }, undefined);
    button(this.toggle, () => this.setOpen(!this.open), true, audio);
    this.tray.el.classList.add('net-hit');
    this.setOpen(false);
  }

  private game: ClientGame | null = null;

  private send(id: number): void {
    if (!this.game || !this.game.sendReaction(id)) return;
    this.setOpen(false); // closeAfterSend
  }

  private setOpen(open: boolean): void {
    this.open = open;
    this.tray.setActive(open && this.usable);
    if (this.tray.activeSelf) {
      applyLayoutGroups(this.root, this.pairs);
      const grid = this.root.find('Reaction_Tray/Viewport/Reaction_Grid');
      if (grid) {
        // Re-run the grid with the cloned buttons (pairNodes only knows the authored ones).
        const g = (child('Reaction_Panel')!.children!.find((c) => c.name === 'Reaction_Tray')!.children!.find((c) => c.name === 'Viewport')!.children![0]!.components as { layoutGroup?: unknown }).layoutGroup;
        if (g) applyLayoutGroups(grid, new Map([[grid, { name: 'Reaction_Grid', components: { layoutGroup: g } } as unknown as NodeData]]));
        // Scroll content: the grid extends below the viewport; the viewport scrolls (verticalNormalizedPosition = 1).
        const vp = grid.parent!;
        grid.anchorMin = [0, 1];
        grid.anchorMax = [0, 1];
        grid.pivot = [0, 1];
        grid.anchoredPosition = [0, 0];
        grid.layout();
        vp.el.style.overflowY = 'auto';
        grid.el.style.position = 'relative';
        vp.el.scrollTop = 0;
      }
    }
  }

  render(game: ClientGame | null): void {
    this.game = game;
    const usable = !!game && game.localSeat >= 0;
    if (usable !== this.usable) {
      this.usable = usable;
      this.root.setActive(usable);
      this.setOpen(this.open);
    }
    if (!usable || !game) return;
    const can = game.canReact;
    for (const b of this.buttons) setInteractable(b, can);
    const cd = game.reactionCooldownRemaining;
    const text = cd > 0 ? `${Math.ceil(cd)}s` : '';
    this.status?.setText(text);
    this.status?.setActive(text.length > 0);
  }

  /** DockToChat: the emote button sits chatDockGap (8) above the chat toggle (closed) or window (open). */
  dockTo(chat: ChatPanelView, scale: number): void {
    const target = chat.isOpen ? chat.window : chat.toggle;
    const canvasEl = this.root.parent?.el;
    if (!canvasEl || !target.activeInHierarchy) return;
    const top = (target.el.getBoundingClientRect().top - canvasEl.getBoundingClientRect().top) / scale;
    const fromBottom = (this.root.parent!.h || 0) - top;
    const toggleOffsetY = this.toggle.anchoredPosition[1];
    this.root.anchoredPosition = [this.root.anchoredPosition[0], fromBottom + 8 - toggleOffsetY];
    this.root.layout();
  }
}

// ---------------------------------------------------------------------------------------------------- join / lobby

/** SeatActionButtons (Join_Table) + PokerLobbyView (Start Game, AddBotButton, InviteButton room code). */
class LobbyButtonsView {
  private readonly join: UNode;
  private readonly joinLabel: UNode | null;
  private readonly start: UNode;
  private readonly startLabel: UNode | null;
  private readonly addBot: UNode;
  private readonly invite: UNode;
  private readonly inviteLabel: UNode | null;
  private game: ClientGame | null = null;
  private copiedUntil = 0;

  constructor(parent: UNode, audio: { play(s: PokerSound): void }) {
    const add = (name: string) => parent.add(buildNode({ ...child(name)!, active: false }, { skip: (n) => n.name === 'dot' }));
    this.join = add('Join_Table');
    this.joinLabel = this.join.find('Text (TMP)');
    this.start = add('Start Game');
    this.startLabel = this.start.find('Text (TMP)');
    this.addBot = add('AddBotButton');
    this.invite = add('InviteButton');
    this.inviteLabel = this.invite.find('Text');
    // Rebuy / Cashout are SeatActionButtons' too, but CanCashOut is false and there is no escrow seat to top up on a
    // Coins table, so Unity never shows them; they are not built.
    button(this.join, () => this.game?.requestJoinTable(), true, audio);
    button(this.start, () => this.game?.requestStartGame(), true, audio);
    button(this.addBot, () => this.game?.requestAddBot(), true, audio);
    button(this.invite, () => this.copyCode(), true, audio);
  }

  private copyCode(): void {
    const code = this.game?.roomCode;
    if (!code || StakeSessionNames.isPool(code)) return;
    void navigator.clipboard?.writeText(code).catch(() => undefined);
    this.copiedUntil = performance.now() + 1200; // copiedMessageSeconds
    this.render(this.game);
  }

  render(game: ClientGame | null): void {
    this.game = game;
    const lobby = game?.lobby ?? null;
    if (!game || !lobby) {
      for (const n of [this.join, this.start, this.addBot, this.invite]) n.setActive(false);
      return;
    }
    // SeatActionButtons.Refresh
    const joining = game.isJoining;
    const seatOffered = (game.localSeat < 0 && (lobby.youCanBuyIn || game.isPrivateTable)) || joining;
    this.join.setActive(seatOffered);
    setInteractable(this.join, game.canJoinTable && !joining);
    this.joinLabel?.setText(joining ? 'Joining…' : 'Join table');

    // PokerLobbyView.SetVisible / Render
    const owner = lobby.youAreOwner;
    const playing = lobby.phase === TablePhase.Playing;
    const showBots = owner && !game.isMoneyTable && !lobby.autoStart;
    this.addBot.setActive(showBots);
    setInteractable(this.addBot, showBots && (game.roster ?? []).some((s) => !s.isOccupied));
    this.start.setActive(owner && !playing && !lobby.autoStart && !joining && !seatOffered);
    setInteractable(this.start, !lobby.autoStart && lobby.seatedCount >= lobby.minToStart && lobby.readyCount >= lobby.minToStart);
    this.startLabel?.setText(lobby.phase === TablePhase.GameOver ? 'Play again' : 'Start game');

    // SetRoomCode: "Quick Play" on a shared pool table, else the party code (tap to copy).
    const code = game.roomCode;
    const shared = StakeSessionNames.isPool(code);
    this.invite.setActive(code.length > 0 && !game.isTournament);
    this.inviteLabel?.setText(performance.now() < this.copiedUntil ? 'COPIED!' : shared ? 'Quick Play' : code);
    setInteractable(this.invite, code.length > 0 && !shared);
  }
}

// ---------------------------------------------------------------------------------------------------- private buy-in

/**
 * PrivateBuyInPrompt.Open: 500–1,000 table chips from the Coin balance (blinds 5 / 10). The prompt itself is the web3
 * module's 'private-buy-in' screen (Net/PrivateBuyInPrompt.cs); this keeps the old DOM prompt only as a fallback for a
 * build without it. It closes itself once the seat is taken.
 */
function openPrivateBuyIn(holder: HTMLElement, game: ClientGame, service: NetService, ctx: AppContext): void {
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
  openDomPrivateBuyIn(holder, game, service);
}

function openDomPrivateBuyIn(holder: HTMLElement, game: ClientGame, service: NetService): void {
  holder.querySelector('.net-buyin')?.remove();
  const coins = service.wallet.coins;
  const min = ChainTableMode.PrivateMinBuyIn;
  const max = Math.min(ChainTableMode.PrivateMaxBuyIn, coins);
  const canAfford = coins >= min;
  const n0 = (v: number) => v.toLocaleString('en-US');
  const wrap = document.createElement('div');
  wrap.className = 'net-buyin';
  wrap.innerHTML = `<button class="net-buyin-close" aria-label="Close">×</button><div class="net-buyin-panel"><div class="net-buyin-title">Buy in</div>
    <div class="net-buyin-range"></div><input class="net-buyin-slider" type="range"><button class="net-buyin-join"></button></div>`;
  const range = wrap.querySelector('.net-buyin-range') as HTMLElement;
  const slider = wrap.querySelector('.net-buyin-slider') as HTMLInputElement;
  const join = wrap.querySelector('.net-buyin-join') as HTMLButtonElement;
  range.textContent = canAfford
    ? `${n0(min)} – ${n0(max)}    ·    blinds ${n0(ChainTableMode.PrivateSmallBlind)} / ${n0(ChainTableMode.PrivateBigBlind)}`
    : `You have ${n0(coins)} Coins. This table needs ${n0(min)}–${n0(ChainTableMode.PrivateMaxBuyIn)}.`;
  slider.min = String(min);
  slider.max = String(Math.max(min, max));
  slider.step = String(ChainTableMode.PrivateBigBlind);
  slider.value = String(Math.max(min, max));
  slider.disabled = !canAfford || max <= min;
  const label = () => (join.textContent = canAfford ? `JOIN  –  ${n0(Number(slider.value))}` : 'NOT ENOUGH BALANCE');
  label();
  join.disabled = !canAfford;
  slider.addEventListener('input', label);
  join.addEventListener('click', () => {
    game.confirmPrivateBuyIn(Number(slider.value));
    wrap.remove();
  });
  (wrap.querySelector('.net-buyin-close') as HTMLElement).addEventListener('click', () => wrap.remove());
  const off = game.onChange((w) => {
    if (w === 'seat' && game.localSeat >= 0) {
      wrap.remove();
      off();
    }
  });
  holder.append(wrap);
}

// ---------------------------------------------------------------------------------------------------- voice

const MIC_COLORS = {
  live: { r: 0.2, g: 0.6, b: 0.35, a: 0.95 },
  muted: { r: 0.6, g: 0.22, b: 0.22, a: 0.95 },
  offline: { r: 0.35, g: 0.35, b: 0.35, a: 0.8 },
};

/** PokerSeatMic on the local seat: click mutes (or retries a refused mic); the circle shows the link state. */
function bindSeatMic(s: NetTableSession): void {
  const voice = s.voice;
  if (!voice) return;
  const paint = () => {
    const mic = s.view.micRootForLocal();
    if (!mic) return;
    if (!mic.el.dataset.netMic) {
      mic.el.dataset.netMic = '1';
      mic.el.style.pointerEvents = 'auto';
      mic.el.style.cursor = 'pointer';
      mic.el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (voice.canRetry) voice.retry();
        else voice.toggleMute();
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
