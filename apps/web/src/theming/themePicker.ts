/**
 * The TABLES picker (`Theme_Panel` in FusionSampleMenu_Game.unity) — port of ThemePicker.cs + ThemeCard.cs.
 * Router overlay 'theme-picker' (the menu opens it from its TABLES button).
 *
 * Each card is one table look: picking it applies the theme and the free-play stake for that table
 * (StakeTableSkin.SelectThemeTable). Cards sort cheapest → most expensive; unaffordable tables stay grey with
 * "not enough balance". The big preview behind the cards shows the selected pack's scene and felt.
 *
 * The StakeStrip under the cards is TableBuyInPanel (buy-in slider + JOIN), which belongs to the stakes / menu
 * module: pass `bindBuyIn` to wire it; without it the strip stays hidden.
 */
import type { AppContext, Screen } from '../app/app';
import { PlayerPrefs } from '../app/services';
import { PokerSound } from '@nomad/engine/orchestration/pokerSound';
import type { StakeTier } from '@nomad/engine/stakes/stakes';
import { buildNode, registerTmpFont, UNode, type NodeData, type TextState } from '../hud/unityUi';
import { THEME_DATA, PACKS, spriteFor, type ThemeId, type ThemePack } from './themeData';
import { canAffordTheme, fitCover, pickStakeForTheme, resolvePackIndex, selectedTableTheme, sortThemesByStake, stakeCaption } from './themeLogic';
import type { ThemeService } from './themeService';
import './theming.css';

/** StakeSelection.PrefKey (Game/Stakes/StakeSelection.cs) — the chosen free-play stake's min buy-in, 0 = auto-match. */
export const SELECTED_STAKE_PREF = 'Poker.SelectedStake';
/** Emitted on ctx.events when the picker changes the selected stake: payload { minBuyIn }. */
export const STAKE_CHANGED = 'stake:changed';

export interface ThemePickerApi {
  /** Theme the picker shows as selected. */
  readonly selected: ThemeId;
  close(): void;
}

export interface ThemePickerParams {
  /** Wires the StakeStrip (TableBuyInPanel). Return a cleanup. Without it the strip stays hidden. */
  bindBuyIn?: (strip: UNode, picker: ThemePickerApi) => void | (() => void);
  /** After a table card is picked (theme applied, stake chosen). */
  onSelect?: (theme: ThemeId, stake: StakeTier) => void;
  /** Coin balance for affordability (default: ctx.services.wallet, else unlimited). */
  coins?: () => number;
}

// ThemeCard constants
const SELECTED_SCALE = 1.2;
const NAME_FONT = 22;
const STAKE_FONT = 16;
const NAME_Y = -128;
const STAKE_Y = -160;
const LABEL_W = 210;

registerTmpFont('Roboto-Medium SDF', "'UnityRobotoMedium'");

interface Card {
  theme: ThemeId;
  pack: ThemePack;
  node: UNode;
  colour: UNode | null;
  grey: UNode | null;
  name: UNode | null;
  stake: UNode | null;
  selected: boolean;
  affordable: boolean;
}

export class ThemePickerScreen implements Screen {
  readonly overlay = true;
  private root: HTMLElement | null = null;
  private canvas = new UNode('Canvas');
  private panel!: UNode;
  private cards: Card[] = [];
  private disposers: (() => void)[] = [];
  private params: ThemePickerParams = {};
  private selectedTheme: ThemeId;

  constructor(
    private readonly ctx: AppContext,
    private readonly theme: ThemeService,
  ) {
    this.selectedTheme = theme.current;
  }

  mount(root: HTMLElement, params?: ThemePickerParams): void {
    this.root = root;
    this.params = params ?? {};
    root.classList.add('theme-picker');
    const data = THEME_DATA.picker;

    // Canvas (Screen Space Overlay, CanvasScaler) → FusionMenu (stretched under the 118-unit top bar) → Theme_Panel.
    this.canvas.el.classList.add('theme-picker-canvas');
    root.append(this.canvas.el);
    let parent = this.canvas;
    for (const p of data.parents) {
      const n = new UNode(p.name);
      n.anchorMin = [...p.anchorMin];
      n.anchorMax = [...p.anchorMax];
      n.sizeDelta = [...p.sizeDelta];
      n.anchoredPosition = [...p.anchoredPosition];
      parent.add(n);
      parent = n;
    }
    this.panel = buildNode(data.root, { sprites: THEME_DATA.sprites, fonts: THEME_DATA.fonts });
    parent.add(this.panel);
    this.markBlockers(this.panel, data.root);

    this.wireCloseOnEmptySpace();
    this.wireBackButton();
    this.bindCards();
    this.layout();
    this.open();

    const onResize = () => this.layout();
    window.addEventListener('resize', onResize);
    this.disposers.push(() => window.removeEventListener('resize', onResize));
    // ThemePicker.OnEnable: StakeSelection.Changed / VirtualEconomy.Changed → OnStakeChanged.
    this.disposers.push(this.ctx.events.on('wallet:changed', () => this.onStakeChanged()));
    this.disposers.push(this.ctx.events.on(STAKE_CHANGED, () => this.onStakeChanged()));
    this.disposers.push(this.theme.onChanged(() => this.refreshSelection(this.currentTableTheme())));
    void document.fonts.load("16px 'UnityRobotoMedium'").then(() => {
      this.panel.invalidateText();
      this.layout();
    });
  }

  unmount(): void {
    for (const d of this.disposers.splice(0)) d();
    this.root?.replaceChildren();
    this.root = null;
  }

  /** Theme the picker shows as selected. */
  get selected(): ThemeId {
    return this.selectedTheme;
  }

  // ---------------------------------------------------------------- layout

  /** CanvasScaler: Scale With Screen Size, Match Width Or Height. */
  private layout(): void {
    const el = this.root;
    if (!el) return;
    const w = el.clientWidth || innerWidth;
    const h = el.clientHeight || innerHeight;
    if (!(w > 0 && h > 0)) return; // zero-size viewport (hidden tab / pane): the scale would be 0 and w / s NaN; the next resize lays out
    const sc = THEME_DATA.picker.canvas?.scaler ?? { referenceResolution: [1920, 1080], matchWidthOrHeight: 0.75 };
    const [rw, rh] = sc.referenceResolution;
    const m = sc.matchWidthOrHeight;
    const s = Math.pow(2, (1 - m) * Math.log2(w / rw) + m * Math.log2(h / rh));
    this.canvas.sizeDelta = [w / s, h / s];
    this.canvas.renderScale = s;
    this.canvas.el.style.transform = `scale(${s})`;
    this.canvas.layout();
    this.fitEnvelope(this.panel.find('BG'));
  }

  /** AspectRatioFitter EnvelopeParent on BG: cover the panel at the authored aspect ratio. */
  private fitEnvelope(bg: UNode | null): void {
    if (!bg?.parent) return;
    const comps = this.findNodeData('BG')?.components as { aspectRatioFitter?: { aspectRatio: number } } | undefined;
    const ratio = comps?.aspectRatioFitter?.aspectRatio ?? 2;
    const size = fitCover(ratio * 1000, 1000, bg.parent.w, bg.parent.h);
    if (!size) return;
    bg.anchorMin = [0.5, 0.5];
    bg.anchorMax = [0.5, 0.5];
    bg.anchoredPosition = [0, 0];
    bg.sizeDelta = size;
    bg.layout();
  }

  private findNodeData(name: string): NodeData | undefined {
    return THEME_DATA.picker.root.children?.find((c) => c.name === name);
  }

  /** Images with raycastTarget swallow clicks (so they do not fall through to the Backdrop). */
  private markBlockers(n: UNode, d: NodeData): void {
    const img = d.components?.image as { raycastTarget?: boolean } | undefined;
    if (img?.raycastTarget && n !== this.panel) n.el.classList.add('u-raycast');
    const kids = (d.children ?? []).filter((c) => c.rect);
    kids.forEach((c, i) => n.children[i] && this.markBlockers(n.children[i]!, c));
  }

  // ---------------------------------------------------------------- ThemePicker.Bind

  /** WireCloseOnEmptySpace: the panel's own Button is disabled; a transparent full-rect Backdrop (first child) closes. */
  private wireCloseOnEmptySpace(): void {
    const backdrop = new UNode('Backdrop');
    backdrop.anchorMin = [0, 0];
    backdrop.anchorMax = [1, 1];
    backdrop.sizeDelta = [0, 0];
    this.panel.add(backdrop, 0);
    backdrop.el.classList.add('u-raycast', 'u-click');
    backdrop.el.addEventListener('click', () => this.close());
  }

  /**
   * WireBackButton → Close, then NomadRetentionRuntime.DockCloseUnderTopBar(back, panel, "BACK"): top-right
   * (-18, -118), 148×52, last sibling; its Background art becomes close_btn (Simple, preserve aspect) and the
   * label "BACK" white 16 bold.
   */
  private wireBackButton(): void {
    const back = this.panel.find('Back');
    if (!back) return;
    back.anchorMin = [1, 1];
    back.anchorMax = [1, 1];
    back.pivot = [1, 1];
    back.anchoredPosition = [-18, -118];
    back.sizeDelta = [148, 52];
    back.setAsLastSibling();
    const bg = back.find('Background');
    const closeKey = THEME_DATA.picker.dockCloseSprite;
    const sprite = closeKey ? THEME_DATA.sprites[closeKey] : null;
    if (bg?.image && sprite) {
      bg.image.sprite = sprite;
      bg.image.type = 'Simple';
      bg.image.color = { r: 1, g: 1, b: 1, a: 1 };
      bg.image.preserveAspect = true;
    }
    const label = [...back.walk()].find((n) => n.text);
    if (label?.text) {
      label.text.text = 'BACK';
      label.text.color = { r: 1, g: 1, b: 1, a: 1 };
      label.text.fontSize = label.text.max = label.text.min = 16;
      label.text.autoSize = false;
      label.text.bold = true;
    }
    back.el.classList.add('u-raycast', 'u-click');
    back.el.addEventListener('click', () => this.close());
  }

  /** BindCards: one ThemeCard per Cards_Holder child, matched to a pack by its label, then sorted by stake. */
  private bindCards(): void {
    const holder = this.panel.find('Cards_Holder');
    if (!holder) return;
    const roots = holder.children.filter((c) => c.name.startsWith('Theme_Card') || c.name === 'Card' || c.name.startsWith('Card ('));
    const slotX = roots.map((r) => r.anchoredPosition[0]);
    const used = PACKS.map(() => false);
    for (const node of roots) {
      const nameNode = [...node.walk()].find((n) => n.text && /^(Theme_Name|Text \(TMP\)|Label)$/.test(n.name)) ?? null;
      const i = resolvePackIndex(nameNode?.text?.text ?? null, PACKS, used);
      if (i < 0) continue;
      used[i] = true;
      this.cards.push(this.bindCard(node, PACKS[i]!, nameNode));
    }
    // Left → right: cheapest table to most expensive (HorizontalLayoutGroup re-flows by sibling index).
    this.cards = sortThemesByStake(this.cards);
    this.cards.forEach((c, i) => {
      c.node.anchoredPosition = [slotX[i] ?? c.node.anchoredPosition[0], c.node.anchoredPosition[1]];
      c.node.setAsLastSibling();
    });
  }

  /** ThemeCard.Bind. */
  private bindCard(node: UNode, pack: ThemePack, nameNode: UNode | null): Card {
    const find = (n: string) => [...node.walk()].find((k) => k.name === n) ?? null;
    const colour = find('Theme_Image') ?? find('card_Colour');
    const grey = find('card_Grey');
    node.scale = [1, 1];
    // New Card art shows the theme's card backs (legacy Theme_Card: the preview).
    if (colour?.image) {
      const sp = (grey && spriteFor(pack, 'CardBack')) || spriteFor(pack, 'Preview') || spriteFor(pack, 'CardBack');
      if (sp) {
        colour.image.sprite = sp;
        colour.image.color = { r: 1, g: 1, b: 1, a: 1 };
      }
    }
    if (grey?.image) {
      const sp = spriteFor(pack, 'CardBackFolded') ?? spriteFor(pack, 'CardBack');
      if (sp) {
        grey.image.sprite = sp;
        grey.image.color = { r: 1, g: 1, b: 1, a: 1 };
      }
    }
    const stake = nameNode ? this.ensureStakeLabel(nameNode) : null;
    const card: Card = { theme: pack.theme, pack, node, colour, grey, name: nameNode, stake, selected: false, affordable: true };
    // ApplyLabels
    if (nameNode?.text) {
      nameNode.text.text = pack.displayName;
      styleLabel(nameNode, NAME_FONT, NAME_Y, 30, false);
    }
    if (stake?.text) {
      stake.text.text = stakeCaption(pack.theme);
      styleLabel(stake, STAKE_FONT, STAKE_Y, 48, true);
    }
    node.el.classList.add('u-raycast', 'u-click');
    node.el.addEventListener('click', () => {
      if (card.affordable) this.select(card.theme);
    });
    this.refreshAffordability(card);
    return card;
  }

  /** ThemeCard.EnsureStakeLabel: a second TMP next to the name, same font, white. */
  private ensureStakeLabel(nameNode: UNode): UNode {
    const n = new UNode('Stake_Label');
    n.text = { ...(nameNode.text as TextState), color: { r: 1, g: 1, b: 1, a: 1 } };
    nameNode.parent!.add(n);
    return n;
  }

  /** ThemeCard.RefreshAffordability. */
  private refreshAffordability(c: Card): void {
    c.affordable = canAffordTheme(c.theme, this.coins());
    c.node.el.classList.toggle('u-disabled', !c.affordable);
    if (c.stake?.text) {
      const caption = stakeCaption(c.theme);
      if (c.affordable) {
        c.stake.text.text = caption;
        c.stake.text.color = { r: 1, g: 1, b: 1, a: 1 };
        styleLabel(c.stake, STAKE_FONT, STAKE_Y, 48, true);
      } else {
        c.stake.text.text = caption + '\nnot enough balance';
        c.stake.text.color = { r: 1, g: 0.55, b: 0.45, a: 1 };
        styleLabel(c.stake, STAKE_FONT, STAKE_Y, 64, true);
      }
    }
    if (c.name?.text) c.name.text.color = { r: 1, g: 1, b: 1, a: c.affordable ? 1 : 0.55 };
    this.applySelectedVisual(c);
  }

  /** ThemeCard.ApplySelectedVisual: selected + affordable = colour art + ×1.2 (labels keep their size); else grey. */
  private applySelectedVisual(c: Card): void {
    const highlight = c.selected && c.affordable;
    c.grey?.setActive(!highlight);
    c.node.scale = highlight ? [SELECTED_SCALE, SELECTED_SCALE] : [1, 1];
    const inv = highlight ? 1 / SELECTED_SCALE : 1;
    if (c.name) c.name.scale = [inv, inv];
    if (c.stake) c.stake.scale = [inv, inv];
    c.node.layout();
  }

  private coins(): number {
    if (this.params.coins) return this.params.coins();
    return this.ctx.services.wallet?.coins ?? Number.POSITIVE_INFINITY;
  }

  // ---------------------------------------------------------------- open / select / close

  /** ThemePicker.Open. */
  private open(): void {
    this.panel.setActive(true);
    const strip = this.panel.find('StakeStrip');
    if (strip) {
      const cleanup = this.params.bindBuyIn?.(strip, this);
      if (this.params.bindBuyIn) strip.setActive(true);
      else strip.setActive(false);
      if (typeof cleanup === 'function') this.disposers.push(cleanup);
    }
    this.refreshSelection(this.currentTableTheme());
    this.onStakeChanged();
  }

  /** ThemePicker.Close (Back / Backdrop). */
  close(): void {
    if (this.ctx.router.current === 'theme-picker') this.ctx.router.back();
  }

  /** ThemePicker.Select → StakeTableSkin.SelectThemeTable. */
  select(theme: ThemeId): void {
    if (!canAffordTheme(theme, this.coins())) return;
    this.theme.setTheme(theme);
    const stake = pickStakeForTheme(theme, this.coins());
    setSelectedStake(this.ctx, stake.minBuyIn);
    this.refreshSelection(theme);
    this.ctx.audio.play(PokerSound.ButtonStart);
    this.params.onSelect?.(theme, stake);
  }

  /** ThemePicker.OnStakeChanged. */
  private onStakeChanged(): void {
    for (const c of this.cards) this.refreshAffordability(c);
    this.refreshSelection(this.currentTableTheme());
  }

  /** ThemePicker.SelectedTableTheme. */
  private currentTableTheme(): ThemeId {
    return selectedTableTheme(PlayerPrefs.getInt(SELECTED_STAKE_PREF, 0), this.theme.current);
  }

  /** ThemePicker.RefreshSelection: card states + the preview (BG = scene, Table = felt). */
  private refreshSelection(theme: ThemeId): void {
    this.selectedTheme = theme;
    for (const c of this.cards) {
      c.selected = c.theme === theme;
      this.applySelectedVisual(c);
    }
    const pack = this.theme.getPack(theme);
    const bg = this.panel.find('BG');
    const table = this.panel.find('Table');
    const scene = spriteFor(pack, 'TableBackground') ?? spriteFor(pack, 'Preview');
    if (bg?.image && scene) Object.assign(bg.image, { sprite: scene, color: { r: 1, g: 1, b: 1, a: 1 }, type: 'Simple', preserveAspect: false });
    const board = spriteFor(pack, 'Board');
    if (table?.image && board) Object.assign(table.image, { sprite: board, color: { r: 1, g: 1, b: 1, a: 1 }, type: 'Simple', preserveAspect: true });
    bg?.render();
    table?.render();
  }
}

/** ThemeCard.StyleLabel: fixed size, centred, pivot top-centre under the card art, TMP line spacing −10. */
function styleLabel(n: UNode, fontSize: number, y: number, height: number, wrap: boolean): void {
  const t = n.text!;
  t.autoSize = false;
  t.fontSize = t.min = t.max = fontSize;
  t.alignH = 'center';
  t.alignV = 'middle';
  t.wrap = wrap;
  // lineSpacing −10 (TMP: hundredths of an em added to the font's line height)
  t.lineRatio = Math.max(0.5, baseLineRatio(t) - 0.1);
  n.anchorMin = [0.5, 0.5];
  n.anchorMax = [0.5, 0.5];
  n.pivot = [0.5, 1];
  n.anchoredPosition = [0, y];
  n.sizeDelta = [LABEL_W, height];
  n.scale = [1, 1];
  n.rotation = 0;
}

const baseRatios = new WeakMap<TextState, number>();
function baseLineRatio(t: TextState): number {
  let r = baseRatios.get(t);
  if (r === undefined) baseRatios.set(t, (r = t.lineRatio));
  return r;
}

/** StakeSelection.SelectedMinBuyIn setter (persisted under the C# key) + 'stake:changed' for the stakes module. */
export function setSelectedStake(ctx: AppContext, minBuyIn: number): void {
  if (PlayerPrefs.getInt(SELECTED_STAKE_PREF, 0) === minBuyIn) return;
  PlayerPrefs.setInt(SELECTED_STAKE_PREF, minBuyIn);
  ctx.events.emit(STAKE_CHANGED, { minBuyIn });
}
