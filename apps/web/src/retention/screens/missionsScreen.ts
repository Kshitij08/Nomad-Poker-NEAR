/**
 * Daily + weekly missions with claim buttons and the level readout (RetentionHud's 'Missions panel ui').
 * Port of Game/Retention/MissionsPanel.cs + MissionRowView.cs (+ NomadRetentionRuntime.ApplyFigmaMissions /
 * DockCloseUnderTopBar): DAILY header, 5 rows, WEEKLY header, 3 rows, each row repaired to the C# layout
 * (RepairMissionRow) and painted by MissionRowView.Bind (Resources/Retention/Art/Missions sprites).
 *
 * Router id 'missions' (overlay). In the shipped Nomad flow the menu's LevelRewards screen shows missions instead
 * (it binds ctx.services.retention.missionRows()); this panel is what the table's Level / Missions chips open.
 */
import { MissionCatalog, PlayerLevelMath, rewardPreview, type MissionBoardState, type MissionDef } from '@nomad/engine/retention';
import { PokerSound } from '@nomad/engine/orchestration/pokerSound';
import { formatN0 } from '@nomad/engine/util/dotnetMath';
import { UNode, type RGBA } from '../../hud/unityUi';
import {
  RetentionColors, applySprite, dataOf, instantiate, setImageColor, setRichText, setXpBarProgress, wireButton,
  type ButtonHandle,
} from '../ui/retentionUi';
import { PanelScreen } from './panelScreen';

const WeeklyBlue: RGBA = { r: 0.62, g: 0.78, b: 1, a: 1 };

interface RowView {
  node: UNode;
  def: MissionDef;
  title: UNode | null;
  progress: UNode | null;
  claim: UNode | null;
  claimLabel: UNode | null;
  claimButton: ButtonHandle | null;
}

export class MissionsScreen extends PanelScreen {
  private levelTitle: UNode | null = null;
  private levelDetail: UNode | null = null;
  private xpFill: UNode | null = null;
  private listRoot: UNode | null = null;
  private viewport: UNode | null = null;
  private statusLabel: UNode | null = null;
  private closeButton: UNode | null = null;
  private rows: RowView[] = [];
  private headers: UNode[] = [];

  constructor(ctx: ConstructorParameters<typeof PanelScreen>[0]) {
    super(ctx, 'missions');
  }

  protected build(): void {
    const f = this.built.script('MissionsPanel') ?? {};
    this.levelTitle = this.ref(f, 'levelTitle');
    this.levelDetail = this.ref(f, 'levelDetail');
    this.xpFill = this.ref(f, 'xpFill');
    this.listRoot = this.ref(f, 'listRoot');
    this.viewport = this.listRoot?.parent ?? null;
    this.statusLabel = this.ref(f, 'statusLabel');
    this.closeButton = this.ref(f, 'closeButton');
    const template = this.ref(f, 'rowPrefab');
    wireButton(this.ctx, this.ref(f, 'dimmerButton'), () => this.hide());
    wireButton(this.ctx, this.closeButton, () => this.hide());
    this.applyFigmaMissions();
    this.ensureRows(template);
    if (this.viewport) this.viewport.el.classList.add('rt-scroll');
    this.listen('progression:changed', () => this.refresh());
    this.listen('wallet:changed', () => this.refresh());
  }

  protected afterMount(): void {
    this.canvas?.onBeforeLayout(() => this.layoutList());
    this.refresh();
  }

  /** NomadRetentionRuntime.ApplyFigmaMissions + DockCloseUnderTopBar. */
  private applyFigmaMissions(): void {
    const sheet = this.root.find('Sheet');
    if (sheet?.image) {
      if (!sheet.image.sprite) applySprite(sheet, 'Retention/Art/Missions/bg');
      sheet.image.preserveAspect = false;
      if (sheet.image.sprite) sheet.image.type = 'Sliced';
    }
    const track = sheet?.find('XpTrack');
    if (track?.image) {
      track.image.sprite = null;
      track.image.color = { r: 0.08, g: 0.1, b: 0.18, a: 1 };
      track.image.type = 'Simple';
    }
    this.dockClose();
  }

  private dockClose(): void {
    const b = this.closeButton;
    if (!b) return;
    if (b.parent !== this.root && b.parent) {
      b.parent.children.splice(b.parent.children.indexOf(b), 1);
      this.root.add(b);
    } else b.setAsLastSibling();
    b.anchorMin = [1, 1];
    b.anchorMax = [1, 1];
    b.pivot = [1, 1];
    b.anchoredPosition = [-18, -118];
    b.sizeDelta = [148, 52];
    applySprite(b, 'Retention/Art/WeeklyRewards/close_btn', false);
    const label = [...b.walk()].find((n) => n.text);
    if (label?.text) {
      label.text.text = 'CLOSE';
      label.text.color = RetentionColors.White;
      label.text.fontSize = 16;
      label.text.autoSize = false;
      label.text.bold = true;
    }
  }

  // ---------------------------------------------------------------- rows

  private ensureRows(template: UNode | null): void {
    const list = this.listRoot;
    if (!list) return;
    template?.setActive(false);
    const tplData = template ? dataOf(template) : undefined;
    this.buildSectionHeader(list, 'DailyHeader', 'DAILY', RetentionColors.Gold);
    MissionCatalog.Daily.forEach((def, i) => this.spawnRow(list, tplData, def, i));
    this.buildSectionHeader(list, 'WeeklyHeader', 'WEEKLY', WeeklyBlue);
    MissionCatalog.Weekly.forEach((def, i) => this.spawnRow(list, tplData, def, MissionCatalog.Daily.length + i));
  }

  private spawnRow(list: UNode, tplData: ReturnType<typeof dataOf>, def: MissionDef, index: number): void {
    if (!tplData) return;
    const node = instantiate({ ...tplData, name: `MissionRow_${index}`, active: true });
    list.add(node);
    const title = node.find('Title');
    const progress = node.find('Progress');
    const claim = node.find('Claim');
    const claimLabel = claim ? ([...claim.walk()].find((n) => n.text) ?? null) : null;
    // RepairMissionRow: title 15 pt left/wrapped, progress 64 wide, claim 110 × 40.
    if (title?.text) {
      title.text.alignH = 'left';
      title.text.alignV = 'middle';
      title.text.wrap = true;
      title.text.fontSize = 15;
      title.text.autoSize = false;
    }
    if (claim) {
      claim.sizeDelta = [110, 40];
      claim.setActive(true);
    }
    const row: RowView = { node, def, title, progress, claim, claimLabel, claimButton: null };
    row.claimButton = wireButton(this.ctx, claim, () => this.onClaim(def.id));
    this.rows.push(row);
  }

  private buildSectionHeader(parent: UNode, name: string, label: string, accent: RGBA): void {
    const go = new UNode(name);
    go.sizeDelta = [0, 36];
    const text = new UNode('Label');
    const like = this.levelDetail?.text;
    text.text = {
      text: label, family: like?.family ?? "'UnityNotoSansBold'", lineRatio: like?.lineRatio ?? 1.362, fontSize: 15, autoSize: false, min: 10, max: 15,
      bold: true, upper: false, color: accent, alignH: 'left', alignV: 'middle', wrap: false, margin: [0, 0, 0, 0], underlay: null,
    };
    const rule = new UNode('Rule');
    rule.image = {
      sprite: null, type: 'Simple', ppuM: 1, color: { ...accent, a: 0.45 }, preserveAspect: false, fillMethod: '', fillAmount: 1, fillOrigin: 0, fillClockwise: true,
    };
    go.add(text);
    go.add(rule);
    parent.add(go);
    this.headers.push(go);
  }

  /** VerticalLayoutGroup (Content) + each row's HorizontalLayoutGroup as RepairMissionRow sets them up. */
  private layoutList(): void {
    const list = this.listRoot;
    const vp = this.viewport;
    if (!list || !vp) return;
    const lg = dataOf(list)?.components?.layoutGroup;
    const spacing = typeof lg?.spacing === 'number' ? lg.spacing : 8;
    const width = vp.w;
    let y = 0;
    const kids = list.children.filter((c) => c.activeSelf);
    kids.forEach((c, i) => {
      const h = this.headers.includes(c) ? 36 : 78;
      c.anchorMin = [0, 1];
      c.anchorMax = [0, 1];
      c.pivot = [0.5, 0.5];
      c.sizeDelta = [width, h];
      c.anchoredPosition = [width / 2, -(y + h / 2)];
      y += h + (i < kids.length - 1 ? spacing : 0);
      if (this.headers.includes(c)) this.layoutHeader(c, width);
      else this.layoutRow(c, width);
    });
    // ContentSizeFitter (vertical PreferredSize): Content grows; the viewport scrolls it.
    list.anchorMin = [0, 1];
    list.anchorMax = [1, 1];
    list.pivot = [0.5, 1];
    list.sizeDelta = [0, y];
    list.anchoredPosition = [0, 0];
  }

  private layoutHeader(go: UNode, width: number): void {
    const [label, rule] = go.children;
    // padding 8,8,6,6 · spacing 12 · label 110 wide · rule flexible, 2 high.
    if (label) {
      place(label, 8, 110, 6, 24, 36);
    }
    if (rule) place(rule, 8 + 110 + 12, Math.max(0, width - 16 - 110 - 12), (36 - 2) / 2, 2, 36);
  }

  private layoutRow(row: UNode, width: number): void {
    // RepairMissionRow: padding 12,12,8,8 · spacing 10 · Title flexible (min 200, pref 360, 56 high) · Progress 64 ·
    // Claim 110 × 40. Middle-left alignment, children's heights as set.
    const v = this.rows.find((r) => r.node === row);
    if (!v) return;
    const inner = width - 24 - 20;
    const fixed = 64 + 110;
    const titleW = Math.max(200, inner - fixed);
    let x = 12;
    if (v.title) place(v.title, x, titleW, (78 - 56) / 2, 56, 78);
    x += titleW + 10;
    if (v.progress) place(v.progress, x, 64, (78 - 56) / 2, 56, 78);
    x += 64 + 10;
    if (v.claim) place(v.claim, x, 110, (78 - 40) / 2, 40, 78);
  }

  // ---------------------------------------------------------------- refresh

  private onClaim(missionId: string): void {
    const svc = this.svc;
    if (!svc) return;
    const res = svc.progression.tryClaimMission(missionId);
    if (res.ok) this.ctx.audio.play(PokerSound.ChipsToWinner);
    this.statusLabel?.setText(res.message);
    this.refresh();
  }

  private refresh(): void {
    const svc = this.svc;
    if (!svc) return;
    const p = svc.progression;
    this.levelTitle?.setText(`LEVEL ${p.level}`);
    if (this.levelDetail) {
      const into = p.xpIntoLevel;
      const need = PlayerLevelMath.xpToReachNext(p.level);
      const toast = p.lastLevelUpToast;
      this.levelDetail.setText(toast ? `${formatN0(into)} / ${formatN0(need)} XP  ·  ${toast}` : `${formatN0(into)} / ${formatN0(need)} XP to next level`);
    }
    setXpBarProgress(this.xpFill, p.levelProgress01);
    const board = p.missionBoard;
    for (const r of this.rows) this.bindRow(r, board);
    this.statusLabel?.setActive(false);
    this.relayout();
  }

  /** MissionRowView.Bind. */
  private bindRow(r: RowView, board: MissionBoardState): void {
    const def = r.def;
    const slot = board.slots.find((s) => s.id === def.id);
    const progress = slot?.progress ?? 0;
    const claimed = slot?.claimed ?? false;
    const complete = progress >= def.target;
    const preview = rewardPreview(def);
    if (r.title) {
      let rich = def.title;
      if (preview) rich += '\n<size=90%><color=#FFD36A>Reward: ' + preview + '</color></size>';
      if (r.title.text) r.title.text.color = RetentionColors.White;
      setRichText(r.title, rich);
    }
    if (r.progress) {
      r.progress.setText(`${Math.min(progress, def.target)}/${def.target}`);
      r.progress.setTextColor(def.weekly ? WeeklyBlue : RetentionColors.Gold);
    }
    if (r.claim) {
      const canClaim = complete && !claimed;
      r.claimButton?.setInteractable(canClaim);
      r.claim.setActive(true);
      if (applySprite(r.claim, canClaim ? 'Retention/Art/Missions/claim' : 'Retention/Art/Missions/locked')) setImageColor(r.claim, RetentionColors.White);
      else setImageColor(r.claim, canClaim ? RetentionColors.Gold : claimed ? RetentionColors.DayDone : { r: 0.28, g: 0.3, b: 0.36, a: 1 });
    }
    if (r.claimLabel) {
      r.claimLabel.setText(claimed ? 'Done' : complete ? 'Claim' : '…');
      r.claimLabel.setTextColor(complete && !claimed ? RetentionColors.SpinLabelDark : RetentionColors.White);
    }
    const tint: RGBA = claimed ? { r: 0.7, g: 0.7, b: 0.75, a: 1 } : def.weekly ? { r: 0.72, g: 0.82, b: 1, a: 1 } : RetentionColors.White;
    if (applySprite(r.node, claimed || complete ? 'Retention/Art/Missions/collect' : 'Retention/Art/Missions/pending')) setImageColor(r.node, tint);
    else setImageColor(r.node, claimed ? RetentionColors.DayDone : complete ? RetentionColors.DayCurrent : def.weekly ? { r: 0.14, g: 0.2, b: 0.38, a: 1 } : RetentionColors.Reel);
  }
}

/** Positions a child inside a row of height `rowH` from the top-left (x, y down), with its size. */
function place(n: UNode, x: number, w: number, yTop: number, h: number, _rowH: number): void {
  n.anchorMin = [0, 1];
  n.anchorMax = [0, 1];
  n.pivot = [0.5, 0.5];
  n.sizeDelta = [w, h];
  n.anchoredPosition = [x + w / 2, -(yTop + h / 2)];
}
