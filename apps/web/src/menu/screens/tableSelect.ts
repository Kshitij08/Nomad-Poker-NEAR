/**
 * Table select (TableSelect_TownLobby): ports of Game/UI/TableSelectController.cs (the scene component: card sizes,
 * glow, pedestal, the Selected Table panel and buy-in buttons) and of the table-select part of NomadUiHost.Social.cs
 * (BindTableSelect / PaintTableSelect / LayoutTableSelect / PaintThemePreview), which binds the same cards to the stake
 * selection and paints over the controller's texts. Join sits at the chosen table: the net module's FreePlayJoin when
 * installed, otherwise the offline single-player table at that stake.
 *
 * ONCHAIN (SOL levels and lamport buy-ins, PerHost.Stakes) belongs to the web3 partial: it can take over through
 * `tableSelectOnchain`.
 */
import type { UNode } from '../../hud/unityUi';
import { StakeCatalog, formatN0, type StakeTier } from '../../core';
import { MENU_DATA, scriptOf, type RefData } from '../data';
import { NomadHost } from '../host';
import { StakeTableSkin, type Theme } from '../stakes';
import { svc } from '../deps';
import { imageComp, make, newImage, synth } from '../ui/canvas';
import { nodeData, widgetsOf } from '../ui/tree';
import { joinFreePlay } from './mainMenu';

const TABLE_CARDS: { card: string; id: string; theme: Theme }[] = [
  { card: 'Card_Solana', id: 'Solana', theme: 'Default' },
  { card: 'Card_Forest', id: 'Forest', theme: 'Forest' },
  { card: 'Card_Town', id: 'Town', theme: 'Town' },
  { card: 'Card_Desert', id: 'Desert', theme: 'Desert' },
  { card: 'Card_NeonCity', id: 'NeonCity', theme: 'Neon_City' },
];
const SCREEN = 'TableSelect_TownLobby';

/** The web3 partial's ONCHAIN table select (SOL stakes); return true from `join` / `paint` when it handled them. */
export interface TableSelectOnchain {
  paint?(host: NomadHost, root: UNode, level: number): boolean;
  step?(host: NomadHost, level: number, dir: number): boolean;
  setEnd?(host: NomadHost, level: number, end: 'min' | 'max' | 'double'): boolean;
  join?(host: NomadHost, level: number): boolean;
}
export const tableSelectOnchain: TableSelectOnchain = {};

// ---------------------------------------------------------------- TableSelectController

interface TableOption {
  Key: string;
  DisplayName: string;
  Stakes: string;
  SmallBlind: number;
  BigBlind: number;
  MinBuyIn: number;
  MaxBuyIn: number;
  Thumbnail: string | null;
  Preview: string | null;
}
interface CardView {
  card: UNode;
  glow: UNode | null;
  name: UNode | null;
  tier: UNode | null;
  line: UNode | null;
  diamond: UNode | null;
  baseY: number;
  aspect: number;
}

class TableSelectController {
  readonly tables: TableOption[];
  private readonly f: Record<string, unknown>;
  private readonly cards: (CardView | null)[] = [];
  private readonly pedestal: UNode | null;
  private selected = -1;
  buyIn = 0;

  constructor(private readonly host: NomadHost, private readonly root: UNode) {
    const s = scriptOf(nodeData(root)!, 'TableSelectController');
    this.f = s?.fields ?? {};
    const raw = (this.f.tables as Record<string, unknown>[] | undefined) ?? [];
    this.tables = raw.map((t) => ({
      Key: String(t.Key), DisplayName: String(t.DisplayName), Stakes: String(t.Stakes),
      SmallBlind: Number(t.SmallBlind), BigBlind: Number(t.BigBlind), MinBuyIn: Number(t.MinBuyIn), MaxBuyIn: Number(t.MaxBuyIn),
      Thumbnail: (t.Thumbnail as RefData | null)?.sprite ?? null, Preview: (t.Preview as RefData | null)?.sprite ?? null,
    }));
    const cardsRoot = host.find(root, 'ThemeCards');
    this.pedestal = cardsRoot?.find('Pedestal_Selected') ?? null;
    const defaultIndex = this.num('defaultIndex', 2);
    this.tables.forEach((t, i) => {
      const card = cardsRoot?.find('Card_' + t.Key) ?? null;
      if (!card || !cardsRoot) return this.cards.push(null);
      this.cards.push({
        card,
        glow: card.find('Glow'),
        name: cardsRoot.find('Name_' + t.Key),
        tier: cardsRoot.find('Tier_' + t.Key),
        line: cardsRoot.find('Line_' + t.Key),
        diamond: cardsRoot.find('Diamond_' + t.Key),
        baseY: card.anchoredPosition[1] - (i === defaultIndex ? this.num('selectedRaise', 21) : 0),
        aspect: card.sizeDelta[0] / Math.max(1, card.sizeDelta[1]),
      });
      widgetsOf(card).button?.addListener(() => this.select(i));
    });
    const wire = (path: string, fn: () => void) => {
      const n = host.find(root, path);
      if (n) widgetsOf(n).button?.addListener(fn);
    };
    wire('SelectedTablePanel/Btn_Minus', () => this.setBuyIn(this.buyIn - this.step()));
    wire('SelectedTablePanel/Btn_Plus', () => this.setBuyIn(this.buyIn + this.step()));
    wire('SelectedTablePanel/Btn_MIN', () => this.sel && this.setBuyIn(this.sel.MinBuyIn));
    wire('SelectedTablePanel/Btn_Double', () => this.setBuyIn(this.buyIn * 2));
    wire('SelectedTablePanel/Btn_MAX', () => this.sel && this.setBuyIn(this.sel.MaxBuyIn));
    root.onEnable.unshift(() => this.select(this.selected >= 0 ? this.selected : Math.max(0, Math.min(defaultIndex, this.tables.length - 1))));
  }

  private num(k: string, d: number): number {
    const v = Number(this.f[k]);
    return Number.isFinite(v) ? v : d;
  }

  get sel(): TableOption | null {
    return this.tables[this.selected] ?? null;
  }

  select(index: number): void {
    if (index < 0 || index >= this.tables.length) return;
    this.selected = index;
    const rgbaOf = (k: string, d: [number, number, number, number]) => {
      const c = this.f[k] as { rgba?: [number, number, number, number] } | undefined;
      const [r, g, b, a] = c?.rgba ?? d;
      return { r, g, b, a };
    };
    this.cards.forEach((v, i) => {
      if (!v) return;
      const on = i === index;
      const h = on ? this.num('selectedHeight', 278) : this.num('normalHeight', 254);
      v.card.sizeDelta = [h * v.aspect, h];
      v.card.anchoredPosition = [v.card.anchoredPosition[0], v.baseY + (on ? this.num('selectedRaise', 21) : 0)];
      if (v.glow?.image) {
        const ppu = on ? this.num('glowSelectedPpu', 3.2) : this.num('glowNormalPpu', 4.5);
        v.glow.image.ppuM = ppu;
        const spread = (this.num('glowEdgePixels', 72) / ppu) * 2;
        v.glow.sizeDelta = [spread, spread];
        v.glow.image.color = { ...v.glow.image.color, a: on ? this.num('glowSelectedAlpha', 0.85) : this.num('glowNormalAlpha', 0) };
      }
      if (v.name?.text) setSize(v.name, on ? this.num('nameSelectedSize', 32.4) : this.num('nameNormalSize', 28.8));
      if (v.tier?.text) {
        setSize(v.tier, on ? this.num('tierSelectedSize', 25.2) : this.num('tierNormalSize', 24));
        v.tier.setTextColor(on ? rgbaOf('tierSelectedColor', [1, 1, 1, 1]) : rgbaOf('tierNormalColor', [0.62, 0.69, 0.85, 1]));
      }
      if (v.line) v.line.sizeDelta = [on ? this.num('lineSelectedWidth', 170) : this.num('lineNormalWidth', 104), v.line.sizeDelta[1]];
      if (v.diamond) {
        const d = on ? this.num('diamondSelectedSize', 52) : this.num('diamondNormalSize', 42);
        v.diamond.sizeDelta = [d, d];
      }
      if (on && this.pedestal) this.pedestal.anchoredPosition = [v.card.anchoredPosition[0], this.pedestal.anchoredPosition[1]];
    });
    const t = this.tables[index]!;
    this.host.setText(this.root, 'SelectedTablePanel/TableName', t.DisplayName);
    this.host.setText(this.root, 'SelectedTablePanel/Stakes', t.Stakes);
    this.host.setText(this.root, 'SelectedTablePanel/Blinds', `${formatN0(t.SmallBlind)} / ${formatN0(t.BigBlind)}`);
    this.host.setText(this.root, 'SelectedTablePanel/MinBuyIn', `Minimum buy-in: ${formatN0(t.MinBuyIn)}`);
    if (t.Thumbnail) setSprite(this.host.find(this.root, 'SelectedTablePanel/Thumb/Viewport/Art'), t.Thumbnail);
    if (t.Preview) setSprite(this.host.find(this.root, 'ThemePreview/Viewport/Art'), t.Preview);
    this.setBuyIn(t.MinBuyIn);
    if (this.root.activeSelf) this.root.layout();
  }

  private step(): number {
    return this.sel ? Math.max(1, this.sel.BigBlind * 10) : 1;
  }

  private setBuyIn(value: number): void {
    const t = this.sel;
    if (!t) return;
    this.buyIn = Math.max(t.MinBuyIn, Math.min(Math.max(t.MinBuyIn, t.MaxBuyIn), value));
    this.host.setText(this.root, 'SelectedTablePanel/BuyInField/Value', formatN0(this.buyIn));
  }
}

function setSize(n: UNode, size: number): void {
  if (!n.text) return;
  if (n.text.autoSize) n.text.max = size;
  n.text.fontSize = size;
  n.invalidateText();
}

function setSprite(n: UNode | null, key: string): void {
  const sp = MENU_DATA.sprites[key];
  if (!n?.image || !sp) return;
  n.image.sprite = sp;
  n.render();
}

// ---------------------------------------------------------------- NomadUiHost table select

export function bindTableSelect(host: NomadHost): void {
  const root = host.screen(SCREEN);
  if (!root) return;
  let tableTheme: Theme = StakeTableSkin.themeFor(host.stakes.resolve().minBuyIn);
  let layoutDone = false;
  const controller = new TableSelectController(host, root);
  const stakes = host.stakes;
  const solLevel = () => Math.max(0, TABLE_CARDS.findIndex((c) => c.theme === tableTheme));

  /** The chosen stake if it plays in this room, else the room's entry stake. */
  const selectedTableTier = (): StakeTier => {
    const chosen = stakes.selectedMinBuyIn;
    const tier = chosen > 0 ? StakeCatalog.get(chosen) : stakes.resolve();
    return StakeTableSkin.themeFor(tier.minBuyIn) === tableTheme ? tier : StakeTableSkin.stakesFor(tableTheme)[0]!;
  };

  const paint = () => {
    if (!root) return;
    layoutTableSelect();
    const tier = selectedTableTier();
    let selectedArt: string | null = null;
    for (const c of TABLE_CARDS) {
      const card = host.find(root, 'ThemeCards/' + c.card);
      if (!card) continue;
      const on = c.theme === tableTheme;
      host.setActive(card, 'Glow', on);
      const tierText = host.find(root, 'ThemeCards/Tier_' + c.id);
      tierText?.setTextColor(on ? { r: 1, g: 1, b: 1, a: 1 } : { r: 0.62, g: 0.69, b: 0.85, a: 1 });
      card.scale = on ? [1.06, 1.06] : [1, 1];
      if (on) {
        const art = host.find(card, 'Viewport/Art');
        selectedArt = (art && nodeData(art)?.components?.image?.sprite) ?? null;
        const ped = host.find(root, 'ThemeCards/Pedestal_Selected');
        if (ped && card.parent === ped.parent) ped.anchoredPosition = [ped.anchoredPosition[0] + (centreX(card) - centreX(ped)), ped.anchoredPosition[1]];
      }
      // Locked look on tables the wallet can't afford.
      card.groupAlpha = StakeTableSkin.canAfford(c.theme, stakes.coins) ? 1 : 0.55;
    }
    const id = TABLE_CARDS.find((x) => x.theme === tableTheme)!.id;
    const roomName = id === 'NeonCity' ? 'Neon City' : id;
    host.setText(root, 'SelectedTablePanel/TableName', roomName);
    if (!(host.onchain && tableSelectOnchain.paint?.(host, root, solLevel()))) {
      host.setText(root, 'SelectedTablePanel/Stakes', `${tier.displayName} Stakes`);
      host.setText(root, 'SelectedTablePanel/Blinds', tier.blindsLabel);
      host.setText(root, 'SelectedTablePanel/MinBuyIn', `Minimum buy-in: ${formatN0(tier.minBuyIn)}`);
      // Short of this table's buy-in, the field shows what it takes; Join stays clickable to say so.
      const canSit = stakes.canSit(tier);
      host.setText(root, 'SelectedTablePanel/BuyInField/Value', formatN0(canSit ? stakes.selectedBuyInChips : tier.minBuyIn));
    }
    const join = host.find(root, 'SelectedTablePanel/Btn_JoinTable');
    if (join) widgetsOf(join).button?.setInteractable(true);
    if (selectedArt) setSprite(host.find(root, 'SelectedTablePanel/Thumb/Viewport/Art'), selectedArt);
    host.setText(root, 'ThemePreview/Caption', roomName + ' room');
    host.setText(root, 'ThemePreview/SubCaption', 'Your table plays in this room');
    paintThemePreview(host, root, tableTheme);
    if (root.activeSelf) {
      root.layout();
      host.afterLayout(root);
    }
  };

  /** Once: every card takes Forest's size; a shade under the caption; the preview and cards grow into extra width. */
  const layoutTableSelect = () => {
    if (layoutDone || !root.activeInHierarchy) return;
    layoutDone = true;
    const forest = host.find(root, 'ThemeCards/Card_Forest');
    const town = host.find(root, 'ThemeCards/Card_Town');
    if (forest && town) {
      town.sizeDelta = [...forest.sizeDelta];
      town.anchoredPosition = [town.anchoredPosition[0], forest.anchoredPosition[1]];
      if (town.image) town.image.color = { r: 0.36, g: 0.9, b: 1, a: town.image.color.a };
      const name = host.find(root, 'ThemeCards/Name_Town');
      const forestName = host.find(root, 'ThemeCards/Name_Forest');
      if (name?.text && forestName?.text) {
        name.text.max = forestName.text.max;
        name.text.fontSize = forestName.text.fontSize;
        name.invalidateText();
      }
    }
    const viewport = host.find(root, 'ThemePreview/Viewport');
    if (viewport && !host.find(viewport, 'CaptionShade')) {
      const shade = newImage(viewport, 'CaptionShade', { r: 0.03, g: 0.02, b: 0.12, a: 0.62 });
      shade.anchorMin = [0, 0];
      shade.anchorMax = [1, 0.3];
      shade.sizeDelta = [0, 0];
      shade.el.classList.remove('nm-hit');
      // SetAsLastSibling, but under the caption texts drawn by the preview (they are siblings of Viewport).
      shade.setAsLastSibling();
    }
    // The 16:9 layout left a gap before the right-hand panel on 20:9: the preview and the card row grow into it.
    root.layout();
    const preview = host.find(root, 'ThemePreview');
    const panel = host.find(root, 'SelectedTablePanel');
    if (!preview || !panel) return;
    const left = (n: UNode) => n.el.getBoundingClientRect().left;
    const right = (n: UNode) => n.el.getBoundingClientRect().right;
    const k0 = root.el.getBoundingClientRect().width / Math.max(1, root.w); // screen px per canvas unit
    if (k0 <= 0) return;
    const pl = left(preview) / k0, pr = right(preview) / k0, gap = left(panel) / k0 - pr;
    const designGap = 34;
    if (!(gap > designGap + 4)) return;
    const oldW = pr - pl, newW = oldW + gap - designGap, k = newW / oldW;
    const frameScale = preview.parent?.scale[0] ?? 1;
    preview.sizeDelta = [preview.sizeDelta[0] + (newW - oldW) / frameScale, preview.sizeDelta[1]];
    preview.anchoredPosition = [preview.anchoredPosition[0] + ((newW - oldW) / frameScale) * preview.pivot[0], preview.anchoredPosition[1]];
    const cards = host.find(root, 'ThemeCards');
    if (!cards) return;
    for (const c of TABLE_CARDS) {
      const card = host.find(cards, c.card);
      if (!card) continue;
      const cx = (left(card) + right(card)) / 2 / k0;
      const dx = ((cx - pl) * (k - 1)) / frameScale;
      for (const part of [c.card, 'Name_' + c.id, 'Line_' + c.id, 'Diamond_' + c.id, 'Tier_' + c.id]) {
        const n = host.find(cards, part);
        if (n) n.anchoredPosition = [n.anchoredPosition[0] + dx, n.anchoredPosition[1]];
      }
    }
    root.layout();
  };

  for (const c of TABLE_CARDS) {
    const theme = c.theme;
    host.bind(root, 'ThemeCards/' + c.card, () => {
      tableTheme = theme;
      StakeTableSkin.selectThemeTable(theme, stakes, (t) => svc(host.ctx, 'theme')?.setTheme?.(t));
      // TableSelectController's own listener runs after this one in Unity and repaints its texts; the host's next
      // refresh paints over them again within a second. Here the controller runs first so the end state shows at once.
      queueMicrotask(paint);
    });
  }
  host.bind(root, 'SelectedTablePanel/Btn_Minus', () => stepBuyIn(-1));
  host.bind(root, 'SelectedTablePanel/Btn_Plus', () => stepBuyIn(+1));
  host.bind(root, 'SelectedTablePanel/Btn_MIN', () => setBuyIn('min'));
  host.bind(root, 'SelectedTablePanel/Btn_MAX', () => setBuyIn('max'));
  host.bind(root, 'SelectedTablePanel/Btn_Double', () => setBuyIn('double'));
  host.bind(root, 'SelectedTablePanel/Btn_JoinTable', () => joinSelectedTable());
  stakes.changed.push(() => host.isShowing(SCREEN) && queueMicrotask(paint));

  function setBuyIn(end: 'min' | 'max' | 'double'): void {
    if (host.onchain && tableSelectOnchain.setEnd?.(host, solLevel(), end)) return queueMicrotask(paint);
    const t = stakes.resolve();
    stakes.selectedBuyInChips = end === 'min' ? stakes.minBuyInChips(t) : end === 'max' ? stakes.maxBuyInChips(t) : stakes.selectedBuyInChips * 2;
    queueMicrotask(paint);
  }
  function stepBuyIn(dir: number): void {
    if (host.onchain && tableSelectOnchain.step?.(host, solLevel(), dir)) return queueMicrotask(paint);
    const tier = stakes.resolve();
    stakes.selectedBuyInChips = stakes.selectedBuyInChips + dir * Math.max(1, tier.bigBlind * 10);
    queueMicrotask(paint);
  }
  function joinSelectedTable(): void {
    if (!host.signedIn) return host.show('Login');
    if (host.onchain && tableSelectOnchain.join?.(host, solLevel())) return;
    const tier = selectedTableTier();
    if (!stakes.canSit(tier)) {
      host.message('Not enough Coins', `${tier.displayName} tables need ${formatN0(tier.minBuyIn)} Coins to sit. Pick a lower table, or claim your daily rewards.`);
      return;
    }
    void joinFreePlay(host, tier, stakes.selectedBuyInChips, 'join');
  }

  host.onScreenShown(SCREEN, () => {
    // SyncTableThemeToStake: open on the card of the stake the menu's chip shows and Quick Play plays.
    tableTheme = StakeTableSkin.themeFor(stakes.resolve().minBuyIn);
    paint();
  });
  host.onRefresh(() => host.isShowing(SCREEN) && paint());
  void controller;
}

function centreX(n: UNode): number {
  const r = n.el.getBoundingClientRect();
  const k = r.width / Math.max(1e-6, n.w * n.scale[0]);
  return ((r.left + r.right) / 2) / (k || 1);
}

/** The wide preview is the table you would sit at: that theme's room, with its felt on top. */
function paintThemePreview(host: NomadHost, root: UNode, theme: Theme): void {
  const art = host.find(root, 'ThemePreview/Viewport/Art');
  if (!art?.image) return;
  const pack = MENU_DATA.themes.find((t) => t.theme === theme);
  const scene = pack?.tableBackground ? MENU_DATA.sprites[pack.tableBackground] : null;
  if (scene) {
    // CoverWith: cropped to fill the frame (AspectRatioFitter EnvelopeParent at the sprite's aspect).
    art.image.sprite = scene;
    art.image.type = 'Simple';
    art.image.preserveAspect = false;
    art.image.color = { r: 1, g: 1, b: 1, a: 1 };
    const fit = nodeData(art)?.components?.aspectRatioFitter;
    if (fit) {
      fit.enabled = true;
      fit.aspectMode = 'EnvelopeParent';
      fit.aspectRatio = scene.rect[2] / Math.max(1, scene.rect[3]);
    }
    art.render();
  }
  const board = pack?.board ? MENU_DATA.sprites[pack.board] : null;
  const viewport = art.parent;
  if (!board || !viewport) return;
  let table = viewport.find('Table');
  if (!table) {
    table = make(viewport, synth('Table', { components: { image: { ...imageComp({ r: 1, g: 1, b: 1, a: 1 }, null, 'Simple', 1, false), preserveAspect: true } } }));
  }
  if (!table.image) return;
  table.image.sprite = board;
  table.image.preserveAspect = true;
  const height = (viewport.h >= 1 ? viewport.h : 320) * 0.78;
  const aspect = board.rect[3] > 1 ? board.rect[2] / board.rect[3] : 2.2;
  table.sizeDelta = [height * aspect, height];
  table.setAsLastSibling();
  table.render();
}
