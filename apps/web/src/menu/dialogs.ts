/**
 * Port of Net/NomadUi/NomadDialogs.cs: the message box, the "working…" note, forms, Settings and titled panels with
 * scrolling lists, in the art's look. The pieces are copies of the menu screens' own: the Account window
 * (Login/Panel: its frame and header strip), the main menu's yellow TABLES and blue QUICK PLAY buttons, the Strategy
 * screen's slider and the profile panel's rounded backing.
 *
 * The modal sits on its own full-screen layer above everything (Unity sorting order 960: over the menu, the table
 * HUD and the private-tables UI), so the table shows the same dialogs after the menu has gone.
 */
import { type RGBA, type UNode } from '../hud/unityUi';
import { nodeDataAt, type MenuNodeData } from './data';
import { ScreenCanvas, destroy, imageComp, make, newImage, newText, setOffsets, stretch, synth, textComp, type Vec2 } from './ui/canvas';
import { runLayout, widgetsOf, type MInput } from './ui/tree';
import { PokerAudio } from './audio';

const col = (r: number, g: number, b: number, a = 1): RGBA => ({ r, g, b, a });
const WHITE = col(1, 1, 1);
/** The largest a window shows at (reference pixels): the rest of the 1920 x 1080 screen stays margin. */
const MAX_PANEL: Vec2 = [1780, 960];

export interface TextLine {
  node: UNode;
  setText(text: string): void;
}

export class NomadDialogs {
  private layer: HTMLDivElement | null = null;
  private canvas: ScreenCanvas | null = null;
  private modal: UNode | null = null;
  private modalIsBusy = false;
  private dismissedBusy: string | null = null;
  private inBusy = false;
  /** Escape closes the open dialog (NomadUiHost.GoBack). */
  readonly onClosed: (() => void)[] = [];

  // the art pieces (NomadDialogs.Capture): authored data of the copied nodes
  private readonly windowData = nodeDataAt('Login/Panel');
  private readonly yellowData = nodeDataAt('MainMenu/Center/Btn_Tables');
  private readonly blueData = nodeDataAt('MainMenu/Center/Btn_QuickPlay');
  private readonly sliderData = nodeDataAt('Agents_Strategy/Panel_Parameters/Param_Aggression/Slider');
  private readonly backing = nodeDataAt('MainMenu/ProfileDropdown/Panel/Backing')?.components?.image;

  get isOpen(): boolean {
    return this.modal !== null;
  }

  // ------------------------------------------------------------------------------ message box

  /** A message (and optional second button and text input) over everything. */
  message(title: string, body: string, ok: string | null = 'OK', onOk?: () => void, cancel: string | null = null, onCancel?: () => void, inputPlaceholder: string | null = null, onInput?: (v: string) => void, inputValue: string | null = null): void {
    if (!this.inBusy) this.dismissedBusy = null;
    const panel = this.openModal(title, [800, inputPlaceholder !== null ? 460 : 380]);
    const h = panel.sizeDelta[1];
    const top = h / 2 - 128;
    const bottom = inputPlaceholder !== null ? 0 : -h / 2 + 135;
    const bodyText = newText(panel, 'Body', body, 30, false, [0, (top + bottom) / 2], [700, top - bottom]);
    fitText(bodyText, 30, 18);
    bodyText.setTextColor(col(0.8, 0.84, 0.93));
    const input = inputPlaceholder !== null ? this.newInput(panel, [0, -50], inputPlaceholder, inputValue, false) : null;
    const y = -h / 2 + 75;
    const okFn = () => {
      const v = input?.text;
      this.close();
      onOk?.();
      if (v !== undefined) onInput?.(v);
    };
    const cancelFn = () => {
      this.close();
      onCancel?.();
    };
    if (ok === null) {
      if (cancel !== null) this.button(panel, cancel, false, [0, y], cancelFn);
    } else if (cancel !== null) {
      this.button(panel, cancel, false, [-170, y], cancelFn);
      this.button(panel, ok, true, [170, y], okFn);
    } else this.button(panel, ok, true, [0, y], okFn);
    if (input) input.input.addEventListener('keydown', (e) => e.key === 'Enter' && okFn());
    this.layoutModal();
    input?.input.focus();
  }

  /** A small form: one field per placeholder (secret ones hide what's typed), then Cancel and OK. */
  form(title: string, placeholders: string[], secret: boolean[], ok: string, onOk: (values: string[]) => void, cancel = 'Cancel'): void {
    const n = placeholders.length;
    const panel = this.openModal(title, [800, 300 + n * 90]);
    const h = panel.sizeDelta[1];
    const fields = placeholders.map((p, i) => this.newInput(panel, [0, h / 2 - 165 - i * 90], p, null, !!secret[i]));
    const y = -h / 2 + 75;
    this.button(panel, cancel, false, [-170, y], () => this.close());
    this.button(panel, ok, true, [170, y], () => {
      const values = fields.map((f) => f.text);
      this.close();
      onOk(values);
    });
    this.layoutModal();
    fields[0]?.input.focus();
  }

  /** A note while something runs; the next message replaces it. Close hides it. Never replaces a dialog in use. */
  busy(title: string, text: string): void {
    if (this.modal && !this.modalIsBusy) return;
    if (this.dismissedBusy === title) return;
    this.inBusy = true;
    try {
      this.message(title, text, null, undefined, 'Close', () => (this.dismissedBusy = title));
    } finally {
      this.inBusy = false;
    }
    this.modalIsBusy = true;
  }

  close(): void {
    if (this.modal) destroy(this.modal);
    this.modal = null;
    this.modalIsBusy = false;
    if (this.layer) this.layer.style.display = 'none';
    for (const fn of this.onClosed) fn();
  }

  /** Closes the open modal only if it's a Busy note. */
  closeBusy(): void {
    if (this.modalIsBusy) this.close();
  }

  // ------------------------------------------------------------------------------ settings

  /** Volume, music and sound effects (PokerAudio, saved), account buttons, and Close; at a table, Leave too. */
  settings(leaveTable?: () => void, account: [string, () => void][] = []): void {
    const hasAccount = account.length > 0;
    const panel = this.openModal('Settings', [1180, hasAccount ? 800 : 640]);
    const rows: [string, () => number, (v: number) => void][] = [
      ['Master volume', () => PokerAudio.masterVolume, (v) => (PokerAudio.masterVolume = v)],
      ['Music', () => PokerAudio.musicVolume, (v) => (PokerAudio.musicVolume = v)],
      ['Sound effects', () => PokerAudio.sfxVolume, (v) => (PokerAudio.sfxVolume = v)],
    ];
    rows.forEach(([name, get, set], i) => {
      const row = newImage(panel, 'Row_' + name, col(0.06, 0.09, 0.26, 0.9), [1060, 100]);
      row.anchoredPosition = [0, (hasAccount ? 185 : 135) - i * 118];
      this.round(row);
      const nameT = newText(row, 'Name', name, 34, true, [-330, 0], [340, 44]);
      nameT.text!.alignH = 'left';
      const value = newText(row, 'Value', Math.round(get() * 100) + '%', 30, true, [455, 0], [110, 44]);
      value.text!.alignH = 'right';
      const slider = this.newSlider(row, [125, 0], [560, 22]);
      if (slider) {
        slider.setValueWithoutNotify(get());
        slider.listeners.push((v) => {
          set(v);
          value.setText(Math.round(v * 100) + '%');
        });
      }
    });
    if (hasAccount) {
      const w = Math.min(340, 1060 / account.length - 16);
      account.forEach(([label, action], i) =>
        this.button(panel, label, false, [-530 + w / 2 + i * (1060 / account.length) + (1060 / account.length - w) / 2, -195], action, w),
      );
    }
    const by = -(hasAccount ? 400 : 320) + 75;
    if (leaveTable) {
      this.button(panel, 'Leave table', false, [-175, by], () => {
        this.close();
        leaveTable();
      }, 300);
      this.button(panel, 'Close', true, [175, by], () => this.close(), 300);
    } else this.button(panel, 'Close', true, [0, by], () => this.close(), 300);
    this.layoutModal();
  }

  // ------------------------------------------------------------------------------ panels (lists, reports)

  /** A titled window over everything with a Close button bottom-right; returns the window to fill. */
  panel(title: string, size: Vec2): UNode {
    const panel = this.openModal(title, size);
    this.button(panel, 'Close', false, [size[0] / 2 - 170, -size[1] / 2 + 70], () => this.close(), 260);
    const fit = Math.min(1, MAX_PANEL[1] / size[1], MAX_PANEL[0] / size[0]);
    if (fit < 1) panel.scale = [fit, fit];
    this.layoutModal();
    return panel;
  }

  /** A vertical scrolling list inside a window: area = (left, top, width, height) from the window's centre. */
  scrollList(window: UNode, area: [number, number, number, number], spacing = 12): UNode {
    const [x, y, w, h] = area;
    const content = synth('Content', {
      rect: { anchorMin: [0, 1], anchorMax: [1, 1], pivot: [0.5, 1], sizeDelta: [0, 0] },
      components: {
        layoutGroup: { kind: 'VerticalLayoutGroup', enabled: true, padding: { left: 12, right: 12, top: 12, bottom: 12 }, spacing, childAlignment: 'UpperLeft', reverse: false, controlW: true, controlH: false, expandW: true, expandH: false },
        contentSizeFitter: { horizontal: 'Unconstrained', vertical: 'PreferredSize' },
      },
    });
    const view = synth('List', {
      rect: { anchoredPosition: [x + w / 2, y - h / 2], sizeDelta: [w, h] },
      components: {
        image: imageComp(col(0, 0, 0, 0.18)),
        rectMask2D: { enabled: true, padding: [0, 0, 0, 0] },
        scrollRect: { enabled: true, content: { path: content.path }, viewport: null, horizontal: false, vertical: true, movementType: 'Clamped', scrollSensitivity: 40, verticalScrollbar: null },
      },
      children: [content],
    });
    const v = make(window, view);
    v.layout();
    return v.children[0]!;
  }

  /** A row for a ScrollList: a rounded card of this height (children placed centre-relative). */
  row(content: UNode, height: number): UNode {
    const r = make(content, synth('Row', {
      rect: { sizeDelta: [0, height] },
      components: { image: imageComp(col(0.07, 0.11, 0.3, 0.95)), layoutElement: { ignoreLayout: false, minWidth: -1, minHeight: height, preferredWidth: -1, preferredHeight: height, flexibleWidth: -1, flexibleHeight: -1 } },
    }));
    this.round(r);
    runLayout(content);
    if (content.parent) runLayout(content.parent);
    return r;
  }

  /** Left-aligned text on a row or window, at (x, y) from its centre. */
  line(parent: UNode, text: string, size: number, pos: Vec2, box: Vec2, color: RGBA = WHITE, align: 'left' | 'center' | 'right' = 'left'): UNode {
    const t = make(parent, synth('Text', { rect: { anchoredPosition: pos, sizeDelta: box }, components: { text: textComp(text, size, false, color, align) } }));
    t.text!.rich = true;
    fitText(t, size, Math.max(12, size * 0.6));
    return t;
  }

  // ------------------------------------------------------------------------------ pieces

  private ensureLayer(): ScreenCanvas {
    if (this.canvas && this.layer) {
      this.layer.style.display = '';
      return this.canvas;
    }
    const layer = (this.layer = document.createElement('div'));
    layer.className = 'nm-layer nm-modal-layer';
    document.body.append(layer);
    const root = make(null, synth('NomadMessage', { rect: { anchorMin: [0, 0], anchorMax: [1, 1], sizeDelta: [0, 0] } }));
    this.canvas = new ScreenCanvas(layer, root);
    return this.canvas;
  }

  /** A modal canvas over everything with a dimmed backdrop and a titled window; returns the window. */
  private openModal(title: string, size: Vec2): UNode {
    this.close();
    const c = this.ensureLayer();
    this.layer!.style.display = '';
    const modal = (this.modal = make(c.root, synth('Modal', { rect: { anchorMin: [0, 0], anchorMax: [1, 1], sizeDelta: [0, 0] } })));
    const dim = newImage(modal, 'Dim', col(0, 0, 0, 0.6));
    stretch(dim);
    return this.window(modal, title, size);
  }

  private layoutModal(): void {
    this.canvas?.layout();
  }

  /** A copy of the Account window (its frame and header strip) at this size, titled, with a solid backing. */
  window(parent: UNode, title: string, size: Vec2): UNode {
    if (!this.windowData) {
      const plain = newImage(parent, 'Panel', col(0.1, 0.08, 0.22, 0.97), size);
      newText(plain, 'Title', title, 40, true, [0, size[1] / 2 - 60], [size[0] - 80, 60]);
      return plain;
    }
    const keep: MenuNodeData = { ...this.windowData, active: true, children: (this.windowData.children ?? []).filter((c) => c.name === 'BG' || c.name === 'Header') };
    const panel = make(parent, keep);
    panel.anchorMin = panel.anchorMax = panel.pivot = [0.5, 0.5];
    panel.anchoredPosition = [0, 0];
    panel.sizeDelta = size;
    this.addBacking(panel);
    const header = panel.find('Header');
    if (header) {
      header.anchorMin = [0, 1];
      header.anchorMax = [1, 1];
      header.pivot = [0.5, 1];
      setOffsets(header, [16, -112], [-16, -14]);
      for (const c of header.children) {
        c.anchorMin = [0, 0];
        c.anchorMax = [1, 1];
        if (c.name !== 'BG') setOffsets(c, [0, 0], [0, 0]);
      }
      const t = header.find('Title');
      if (t?.text) {
        t.text.alignH = 'center';
        t.setText(title);
        fitText(t, 48, 24);
      }
    }
    return panel;
  }

  /** A solid, rounded backing under a see-through art panel, just inside its frame. */
  addBacking(panel: UNode, inset = 10): void {
    if (panel.find('Backing')) return;
    const bg = panel.children.findIndex((c) => c.name === 'BG');
    const b = make(panel, synth('Backing', { components: { image: imageComp(col(0.035, 0.07, 0.22, 0.95), this.backing?.sprite ?? null, this.backing?.type ?? 'Simple', (this.backing?.pixelsPerUnitMultiplier ?? 1) * 0.5, false) } }), Math.max(0, bg));
    stretch(b, inset);
  }

  /** Gives an image the dialogs' rounded shape (the profile panel's backing sprite), keeping its colour. */
  round(n: UNode): void {
    if (!n.image || !this.backing) return;
    const keep = n.image.color;
    const tmp = make(null, synth('tmp', { components: { image: imageComp(keep, this.backing.sprite, this.backing.type, this.backing.pixelsPerUnitMultiplier * 0.5) } }));
    n.image = { ...tmp.image!, color: keep };
    n.render();
  }

  /** A copy of the main menu's yellow (TABLES) or blue (QUICK PLAY) button, labelled. */
  button(parent: UNode, label: string, yellow: boolean, pos: Vec2, onClick: () => void, width = 310): UNode {
    const tpl = yellow ? this.yellowData : this.blueData;
    let b: UNode;
    if (!tpl) {
      b = newImage(parent, 'Btn_' + label, yellow ? col(0.98, 0.76, 0.18) : col(0.25, 0.33, 0.7));
      const lt = newText(b, 'Label', label, 30, true, [0, 0], [width - 10, 70]);
      lt.setTextColor(yellow ? col(0.12, 0.08, 0.25) : WHITE);
    } else {
      b = make(parent, { ...tpl, active: true, name: 'Btn_' + label, children: (tpl.children ?? []).filter((c) => c.name !== 'Chevron') });
    }
    b.anchorMin = b.anchorMax = b.pivot = [0.5, 0.5];
    b.anchoredPosition = pos;
    b.sizeDelta = [width, 84];
    const lr = b.find('Label');
    if (lr) {
      lr.anchorMin = [0, 0];
      lr.anchorMax = [1, 1];
      setOffsets(lr, [12, 4], [-12, -4]);
      if (lr.text) {
        lr.text.alignH = 'center';
        lr.setText(label.toUpperCase());
        fitText(lr, 32, 18);
      }
    }
    const w = widgetsOf(b);
    w.button?.reset();
    w.button?.addListener(onClick);
    if (!w.button) b.el.addEventListener('click', onClick);
    b.el.classList.add('nm-interactive');
    if (parent.activeInHierarchy && parent.w > 0) b.layout();
    return b;
  }

  /** A copy of the Strategy screen's slider (track, fill, round handle), 0..1. */
  newSlider(parent: UNode, pos: Vec2, size: Vec2) {
    if (!this.sliderData) return null;
    const s = make(parent, { ...this.sliderData, active: true });
    s.scale = [1, 1];
    s.anchorMin = s.anchorMax = s.pivot = [0.5, 0.5];
    s.anchoredPosition = pos;
    s.sizeDelta = size;
    for (const area of ['Fill Area', 'Handle Slide Area']) {
      const a = s.find(area);
      if (a) stretch(a);
    }
    const h = s.find('Handle Slide Area/Handle');
    if (h) h.sizeDelta = [44, 44];
    const sl = widgetsOf(s).slider;
    if (!sl) return null;
    sl.min = 0;
    sl.max = 1;
    sl.listeners.length = 0;
    return sl;
  }

  /** A text field in the dialogs' look (dark, rounded, the art's font). */
  private newInput(panel: UNode, pos: Vec2, placeholder: string, value: string | null, password: boolean): MInput {
    const textD = synth('Text', { rect: { anchorMin: [0, 0], anchorMax: [1, 1], sizeDelta: [0, 0] }, components: { text: { ...textComp('', 28, false, WHITE, 'left') } } });
    const phD = synth('Placeholder', { rect: { anchorMin: [0, 0], anchorMax: [1, 1], sizeDelta: [0, 0] }, components: { text: { ...textComp(placeholder, 28, false, col(0.55, 0.62, 0.85), 'left') } } });
    const area = synth('Text Area', { rect: { anchorMin: [0, 0], anchorMax: [1, 1], sizeDelta: [-20, -13], anchoredPosition: [0, -0.5] }, components: { rectMask2D: { enabled: true, padding: [0, 0, 0, 0] } }, children: [phD, textD] });
    const sel = { interactable: true, transition: 'None', colors: {}, spriteState: {}, targetGraphic: null } as never;
    const d = synth('InputField (TMP)', {
      rect: { anchoredPosition: pos, sizeDelta: [620, 78] },
      components: {
        image: imageComp(col(0.04, 0.07, 0.2), this.backing?.sprite ?? null, this.backing?.type ?? 'Simple', (this.backing?.pixelsPerUnitMultiplier ?? 1) * 0.5),
        inputField: Object.assign({}, sel as object, { textViewport: { path: area.path }, textComponent: { path: textD.path }, placeholder: { path: phD.path }, text: value ?? '', characterLimit: 0, contentType: password ? 'Password' : 'Standard', lineType: 'SingleLine', readOnly: false }) as never,
      },
      children: [area],
    });
    const n = make(panel, d);
    const input = widgetsOf(n).input!;
    input.input.style.caretColor = '#fff';
    return input;
  }
}

/** FitTexts / the dialogs' label setup: auto-size between min and max, "…" when it still does not fit. */
export function fitText(n: UNode, max: number, min: number): void {
  if (!n.text) return;
  n.text.autoSize = true;
  n.text.max = max;
  n.text.min = Math.min(max, min);
  n.text.ellipsis = true;
  n.invalidateText();
  if (n.parent?.activeInHierarchy && n.parent.w > 0) n.layout();
}

