/**
 * Port of Assets/Scripts/Net/NomadUi/NomadUiHost.Strategy.cs: Agents > Strategy, rebuilt in code inside the art's
 * parameters panel, in two layers (docs/AGENTS_V2.md section 9):
 *   - novice: the playstyle cards (Autopilot, Guardian, Trapper, Daredevil), a Hands played dial and a Pressure dial, a
 *     risk line, and the strategy in one measured sentence;
 *   - Fine-tune (Show / Hide): the five numbers under names that say what they do (AgentStrategyWords), with their
 *     measured effect, over the range the server plays; and the before / after the flop split.
 * Changes apply as they're made (AgentStrategyState, saved on the device); the playstyle cards load a preset.
 *
 * Same rows, sizes and positions as the C# (reference pixels × the panel's unit). The C# also adds a visible scrollbar on
 * the right of the rows; here the list scrolls with the wheel / drag only.
 */
import type { UNode } from '../../hud/unityUi';
import type { RGBA } from '../../hud/unityUi';
import type { NomadHost } from '../../menu/host';
import { fitText } from '../../menu/dialogs';
import { destroy, imageComp, make, setOffsets, synth, textComp } from '../../menu/ui/canvas';
import { runLayout, widgetsOf, type MSlider } from '../../menu/ui/tree';
import {
  AgentStrategyWords as W, BRAIN_SMART, STRATEGY_BLURBS, STRATEGY_NAMES, STRATEGY_PRESETS,
} from '@nomad/engine/agents';
import { roundHalfEven } from '@nomad/engine/util/dotnetMath';
import type { AgentsService } from '../agentsService';

/** The art's four cards, left to right, show the four presets (Custom is the pill, not a card). */
const STYLE_CARDS = ['Style_Guardian', 'Style_Tactician', 'Style_Daredevil', 'Style_Custom'];
const STRAT_ROW: RGBA = { r: 0.07, g: 0.11, b: 0.3, a: 0.95 };
const SOFT: RGBA = { r: 0.66, g: 0.72, b: 0.88, a: 1 };
const GOLD_TAG: RGBA = { r: 1, g: 0.83, b: 0.35, a: 1 };
const SUMMARY: RGBA = { r: 0.85, g: 0.9, b: 1, a: 1 };
const WHITE: RGBA = { r: 1, g: 1, b: 1, a: 1 };
const CLEAR: RGBA = { r: 0, g: 0, b: 0, a: 0 };

const pct = (v: number) => roundHalfEven(Math.fround(v * 100));

export function bindStrategyEditor(host: NomadHost, svc: AgentsService): void {
  const root = host.screen('Agents_Strategy');
  if (!root) return;
  const s = svc.strategy;

  let content: UNode | null = null;
  let view: UNode | null = null;
  let round = -1; // -1 = all rounds; 0 = before the flop, 1 = after it
  let advanced = false; // the Fine-tune rows are open
  let unit = 1; // panel units per reference pixel (the art's panel is 419 reference pixels tall)
  const tags: (UNode | null)[] = new Array(6).fill(null);
  const lines: (UNode | null)[] = new Array(6).fill(null);
  let summary: UNode | null = null;
  let handsTag: UNode | null = null;
  let handsLine: UNode | null = null;
  let pressureTag: UNode | null = null;
  let pressureLine: UNode | null = null;
  let riskTitle: UNode | null = null;
  let riskLine: UNode | null = null;

  // ---- BindStrategyEditor

  const rebind = (path: string, action: () => void) => {
    const b = host.bind(root, path, null, true);
    b?.reset();
    b?.addListener(action);
  };
  STYLE_CARDS.forEach((card, i) => {
    rebind('Panel_Playstyle/' + card, () => pickStyle(i));
    host.setText(root, `Panel_Playstyle/${card}/Name`, STRATEGY_NAMES[i]!);
    host.setText(root, `Panel_Playstyle/${card}/Desc`, STRATEGY_BLURBS[i]!);
  });
  rebind('Btn_Reset', () => pickStyle(resetStyle()));
  rebind('Btn_UseStrategy', () => {
    host.show('Agents_Overview');
    host.message('Strategy saved', `${s.agentName} plays this from its next session: ${s.summary}`);
  });
  host.onScreenShown('Agents_Strategy', () => paintStrategyEditor());
  // My Twin / the marketplace apply a whole strategy while the screen is up: repaint.
  s.onChanged(() => {
    if (host.isShowing('Agents_Strategy') && !editing) queueMicrotask(() => paintStrategyEditor());
  });
  let editing = false;

  const resetStyle = () => (s.style < STRATEGY_PRESETS.length ? s.style : 0);

  function apply<T>(fn: () => T): T {
    editing = true;
    try {
      return fn();
    } finally {
      editing = false;
    }
  }

  function pickStyle(style: number): void {
    apply(() => s.pickStyle(style));
    round = -1;
    paintStrategyEditor();
  }

  // ---- PaintStrategyEditor

  function paintStrategyEditor(): void {
    const panel = host.find(root, 'Panel_Parameters');
    if (!panel) return;
    paintStyleCards();
    for (const c of panel.children)
      if (c.name.startsWith('Param_') || c.name === 'Btn_AdvancedSettings' || c.name === 'AdvancedDropdown' || c.name === 'Sub') c.setActive(false);
    host.setText(panel, 'Title', 'How your Agent plays');
    host.setText(panel, 'PresetPill/Label', s.styleName);
    host.setText(root, 'Btn_Reset/Label', 'Reset to ' + STRATEGY_NAMES[resetStyle()]);
    host.setText(root, 'Btn_UseStrategy/Label', 'Done');

    unit = Math.max(0.1, (panel.h > 0 ? panel.h : panel.sizeDelta[1]) / 419);
    const u = unit;
    if (!content || !view) {
      const c = synth('Content', {
        rect: { anchorMin: [0, 1], anchorMax: [1, 1], pivot: [0.5, 1], sizeDelta: [0, 0] },
        components: {
          layoutGroup: { kind: 'VerticalLayoutGroup', enabled: true, padding: { left: 0, right: 0, top: 0, bottom: 0 }, spacing: 8 * u, childAlignment: 'UpperLeft', reverse: false, controlW: true, controlH: false, expandW: true, expandH: false },
          contentSizeFitter: { horizontal: 'Unconstrained', vertical: 'PreferredSize' },
        },
      } as never);
      const v = synth('StrategyEditor', {
        rect: { anchorMin: [0, 0], anchorMax: [1, 1], sizeDelta: [0, 0] },
        components: {
          image: imageComp(CLEAR, null, 'Simple', 1, true),
          rectMask2D: { enabled: true, padding: [0, 0, 0, 0] },
          // WebGL's wheel steps are small: a high sensitivity so a notch moves about a row.
          scrollRect: { enabled: true, content: { path: c.path }, viewport: null, horizontal: false, vertical: true, movementType: 'Clamped', scrollSensitivity: 450, verticalScrollbar: null },
        },
        children: [c],
      } as never);
      view = make(panel, v);
      setOffsets(view, [18 * u, 14 * u], [-22 * u, -62 * u]);
      content = view.children[0]!;
    }
    for (const c of [...content.children]) destroy(c);
    tags.fill(null);
    lines.fill(null);

    const smart = s.brain === BRAIN_SMART;

    // The strategy in one line, measured.
    const top = rowOf(54);
    summary = text(top, '', 17, 0.02, 0.98, 0, 48, SUMMARY);

    // My Twin plays your own style (the classic rules its fit is made for): say so, and how to switch back.
    if (!smart) text(rowOf(54), 'Plays like you (My Twin). Pick a playstyle above to go back to the Agent’s own play.', 15, 0.02, 0.98, 0, 44, SOFT);

    // The novice dials and the risk line.
    const main = s.values;
    [handsTag, handsLine] = dialRow('Hands played', 'Tight', 'Loose', W.dialForHands(main), (d) => apply(() => s.setHandsDial(d)));
    [pressureTag, pressureLine] = dialRow('Pressure', 'Calm', 'Pushy', W.dialForPressure(W.after(main, s.streets)), (p) => apply(() => s.setPressureDial(p)));
    const risk = rowOf(70);
    riskTitle = text(risk, '', 20, 0.02, 0.3, 14, 30, WHITE, true);
    riskLine = text(risk, '', 15, 0.02, 0.98, -16, 30, SOFT);

    // Fine-tune: the five settings and the before / after the flop split, hidden until asked for.
    const roundsInUse = s.roundValues(0) != null || s.roundValues(1) != null;
    const adv = rowOf(54);
    text(adv, 'Fine-tune', 20, 0.02, 0.2, 0, 30, WHITE, true);
    text(adv, roundsInUse ? 'Five detailed settings. Different play before / after the flop: in use.'
      : 'Five detailed settings, and different play before / after the flop.', 15, 0.22, 0.76, 0, 40, SOFT);
    chip(adv, advanced ? 'Hide' : 'Show', false, 0.8, 0.98, 0, () => {
      advanced = !advanced;
      if (!advanced) round = -1;
      paintStrategyEditor();
    });
    if (!advanced) round = -1;
    else {
      // Betting rounds.
      const rounds = rowOf(96);
      text(rounds, 'Rounds', 20, 0.02, 0.2, 22, 30, WHITE, true);
      const roundNames = ['All', 'Before the flop', 'After the flop'];
      const roundWords = ['', 'before the flop', 'after the flop'];
      for (let r = -1; r < 2; r++) {
        const own = r >= 0 && s.roundValues(r) != null;
        const x0 = 0.22 + (r + 1) * 0.2;
        chip(rounds, roundNames[r + 1]! + (own ? ' *' : ''), round === r, x0, x0 + 0.185, 22, () => {
          round = r;
          paintStrategyEditor();
        });
      }
      const ownRound = round >= 0 && s.roundValues(round) != null;
      const roundLine = round < 0
        ? (roundsInUse ? 'Editing every round: a change here applies before and after the flop. Pick one to edit it alone.'
          : 'Editing every round. Pick before or after the flop to give it its own settings (marked *).')
        : ownRound ? `Editing ${roundWords[round + 1]} only: it plays these numbers there instead of the main ones.`
          : `${roundNames[round + 1]} uses the main settings. Move a slider to give it its own.`;
      text(rounds, roundLine, 15, 0.02, ownRound ? 0.72 : 0.98, -24, 40, SOFT);
      if (ownRound) {
        const k = round;
        chip(rounds, 'Use main', false, 0.74, 0.98, -24, () => {
          apply(() => s.useMain(k));
          paintStrategyEditor();
        });
      }
      // The five settings: this round's own; with "All", the main ones, or (when the rounds have their own) the
      // before-the-flop ones, which are what it actually plays first.
      const shown = (round >= 0 ? s.roundValues(round) : roundsInUse ? s.roundValues(0) : null) ?? s.values;
      for (let i = 0; i < 5; i++) stratSlider(i, shown);
    }
    paintStrategySummary();
    runLayout(content);
    view.layout();
  }

  /** A novice dial: name, the measured tag, a line, and a 0..1 slider between two words. */
  function dialRow(name: string, left: string, right: string, value: number, onChange: (v: number) => void): [UNode, UNode] {
    const row = rowOf(104);
    text(row, name, 20, 0.02, 0.2, 30, 30, WHITE, true);
    text(row, left, 14, 0.21, 0.3, 30, 24, SOFT, false, 'right');
    text(row, right, 14, 0.67, 0.75, 30, 24, SOFT);
    const tag = text(row, '', 18, 0.76, 0.98, 30, 30, GOLD_TAG, false, 'right');
    const line = text(row, '', 15, 0.02, 0.98, -16, 56, SOFT);
    const sl = host.dialogs.newSlider(row, [0, 0], [0, 0]);
    if (sl) {
      placeSlider(sl, 0.31, 0.66);
      sl.min = 0;
      sl.max = 1;
      sl.setValueWithoutNotify(value);
      sl.listeners.push((v) => {
        onChange(v);
        paintStrategySummary();
      });
    }
    return [tag, line];
  }

  function placeSlider(sl: MSlider, x0: number, x1: number): void {
    const n = sl.node;
    n.anchorMin = [x0, 0.5];
    n.anchorMax = [x1, 0.5];
    n.sizeDelta = [0, 14 * unit];
    n.anchoredPosition = [0, 30 * unit];
    const h = n.find('Handle Slide Area/Handle');
    if (h) h.sizeDelta = [30 * unit, 30 * unit];
  }

  function stratSlider(i: number, values: readonly number[]): void {
    // Name, slider and tag on top; the explanation gets two full lines under them.
    const row = rowOf(104);
    text(row, W.Names[i]!, 20, 0.02, 0.2, 30, 30, WHITE, true);
    tags[i] = text(row, W.tag(i, values), 18, 0.76, 0.98, 30, 30, GOLD_TAG, false, 'right');
    lines[i] = text(row, W.explain(i, values), 15, 0.02, 0.98, -16, 56, SOFT);
    const sl = host.dialogs.newSlider(row, [0, 0], [0, 0]);
    if (!sl) return;
    placeSlider(sl, 0.22, 0.74);
    // Right always means more: more calling, more hands (those two numbers grow the other way). Slider.Direction
    // RightToLeft is played as the negated range.
    const rev = W.Reversed[i]!;
    const min = W.Min[i]!;
    const max = W.Max[i]!;
    sl.min = rev ? -max : min;
    sl.max = rev ? -min : max;
    const v = Math.min(max, Math.max(min, values[i]!));
    sl.setValueWithoutNotify(rev ? -v : v);
    sl.listeners.push((x) => onStratSlider(i, rev ? -x : x));
  }

  function onStratSlider(i: number, v: number): void {
    const roundCreated = round >= 0 && s.roundValues(round) == null;
    const edited = apply(() => s.setSlider(i, v, round));
    if (roundCreated) {
      paintStrategyEditor(); // the round's line and "Use main" appear
      return;
    }
    // Hands played depends on two settings: refresh every tag and line.
    for (let k = 0; k < 5; k++) {
      tags[k]?.setText(W.tag(k, edited));
      lines[k]?.setText(W.explain(k, edited));
    }
    paintStrategySummary();
  }

  function paintStyleCards(): void {
    STYLE_CARDS.forEach((card, i) => {
      const n = host.find(root, 'Panel_Playstyle/' + card);
      if (n) widgetsOf(n).selectable?.setSelected(i === s.style);
    });
  }

  function paintStrategySummary(): void {
    summary?.setText(s.summary);
    // The dials' measured tags and the risk line follow every change.
    const main = s.values;
    const pre = W.before(main, s.streets);
    const post = W.after(main, s.streets);
    const hands = W.handsPlayed(pre);
    const pressure = W.dialForPressure(post);
    handsTag?.setText('Plays ' + W.oneIn(hands).replace('about ', ''));
    handsLine?.setText(`How many starting hands it plays: ${W.oneIn(hands)} at a Coins table. Tighter: fewer, stronger hands and smaller swings. Looser: more hands, more action, bigger swings.`);
    pressureTag?.setText(W.pressureWord(pressure));
    pressureLine?.setText(`How hard it pushes good hands: after the flop ${pct(W.pressure(post))}% of its actions are bets or raises, and it bets about ${pct(post[4]!)}% of the pot. Pushier wins bigger pots and swings more.`);
    const risk = W.riskOf(W.swing(pre, post));
    riskTitle?.setText('Risk: ' + risk);
    riskLine?.setText(W.riskLine(risk));
    host.setText(root, 'Panel_Parameters/PresetPill/Label', s.styleName);
    paintStyleCards();
  }

  // ---- row pieces (StratRowOf / StratText / StratChip)

  function rowOf(height: number): UNode {
    const h = height * unit;
    const row = make(content, synth('Row', {
      rect: { sizeDelta: [0, h] },
      components: {
        image: imageComp(STRAT_ROW, null, 'Simple', 1, false),
        layoutElement: { ignoreLayout: false, minWidth: -1, minHeight: h, preferredWidth: -1, preferredHeight: h, flexibleWidth: -1, flexibleHeight: -1 },
      },
    } as never));
    host.dialogs.round(row);
    return row;
  }

  /** Text across the row from x0 to x1 (shares of its width), centred `y` reference pixels above the middle. */
  function text(row: UNode, t: string, size: number, x0: number, x1: number, y: number, height: number, color: RGBA, bold = false, align = 'left'): UNode {
    const n = make(row, synth('Text', {
      rect: { anchorMin: [x0, 0.5], anchorMax: [x1, 0.5], sizeDelta: [0, height * unit], anchoredPosition: [0, y * unit] },
      components: { text: textComp(t, size * unit, bold, color, align) },
    }));
    fitText(n, size * unit, size * unit * 0.7);
    return n;
  }

  function chip(row: UNode, label: string, on: boolean, x0: number, x1: number, y: number, onClick: () => void): void {
    const b = host.dialogs.button(row, label, on, [0, 0], onClick, 100);
    b.anchorMin = [x0, 0.5];
    b.anchorMax = [x1, 0.5];
    b.sizeDelta = [0, 34 * unit];
    b.anchoredPosition = [0, y * unit];
    const t = b.find('Label');
    if (t?.text) {
      t.setText(label);
      fitText(t, 17 * unit, 10 * unit);
    }
  }

}
