/**
 * Typed access to data/menu-ui.json (tools/extract-unity-menu.mjs): the Nomad screens of Assets/Scenes/PokerUI.unity.
 */
import menuJson from '../data/menu-ui.json';
import type { FontData, MaterialData, NodeData, SpriteData, Vec2 } from '../hud/unityUi';

export interface ColorData {
  hex: string;
  rgba: [number, number, number, number];
}
export interface RefData {
  path?: string;
  component?: string;
  sprite?: string;
  asset?: string;
}
export interface PersistentCall {
  target: RefData | null;
  method: string;
  /** UnityEngine.Events.PersistentListenerMode (6 = bool argument). */
  mode: number;
  arg: unknown;
  /** 0 Off, 1 EditorAndRuntime, 2 RuntimeOnly. */
  callState: number;
}
export interface SelectableData {
  interactable: boolean;
  transition: 'None' | 'ColorTint' | 'SpriteSwap' | 'Animation';
  colors: Record<'normal' | 'highlighted' | 'pressed' | 'selected' | 'disabled', ColorData> & { colorMultiplier: number; fadeDuration: number };
  spriteState: { highlighted: string | null; pressed: string | null; disabled: string | null };
  targetGraphic: RefData | null;
}
export interface LayoutGroupData {
  kind: 'HorizontalLayoutGroup' | 'VerticalLayoutGroup' | 'GridLayoutGroup';
  enabled: boolean;
  padding: { left: number; right: number; top: number; bottom: number };
  spacing: number | Vec2;
  childAlignment: string;
  reverse: boolean;
  controlW: boolean;
  controlH: boolean;
  expandW: boolean;
  expandH: boolean;
}
export interface ScriptData {
  script: string;
  enabled: boolean;
  fields: Record<string, unknown>;
}
export interface MenuComponents {
  image?: { enabled: boolean; sprite: string | null; color: ColorData; type: string; raycastTarget: boolean; preserveAspect: boolean; pixelsPerUnitMultiplier: number };
  text?: { enabled: boolean; text: string; fontSize: number; autoSize: boolean; fontSizeMin: number; fontSizeMax: number; overflow: string; raycastTarget: boolean; wrapping: boolean; alignH: string };
  button?: SelectableData & { onClick: PersistentCall[] };
  toggle?: SelectableData & { isOn: boolean; graphic: RefData | null; group: RefData | null; onValueChanged: PersistentCall[] };
  slider?: SelectableData & { direction: string; min: number; max: number; value: number; wholeNumbers: boolean; fillRect: RefData | null; handleRect: RefData | null };
  scrollbar?: SelectableData & { direction: number; value: number; size: number; handleRect: RefData | null };
  scrollRect?: { enabled: boolean; content: RefData | null; viewport: RefData | null; horizontal: boolean; vertical: boolean; movementType: string; scrollSensitivity: number; verticalScrollbar: RefData | null };
  inputField?: SelectableData & { textViewport: RefData | null; textComponent: RefData | null; placeholder: RefData | null; text: string; characterLimit: number; contentType: string; lineType: string; readOnly: boolean };
  canvasGroup?: { enabled: boolean; alpha: number; interactable: boolean; blocksRaycasts: boolean };
  mask?: { enabled: boolean; showMaskGraphic: boolean };
  rectMask2D?: { enabled: boolean; padding: [number, number, number, number] };
  layoutGroup?: LayoutGroupData;
  contentSizeFitter?: { horizontal: string; vertical: string };
  layoutElement?: { ignoreLayout: boolean; minWidth: number; minHeight: number; preferredWidth: number; preferredHeight: number; flexibleWidth: number; flexibleHeight: number };
  aspectRatioFitter?: { enabled: boolean; aspectMode: string; aspectRatio: number };
  other?: (ScriptData | string)[];
}
export type MenuNodeData = Omit<NodeData, 'components' | 'children'> & { components?: MenuComponents; children?: MenuNodeData[] };

export interface MenuCanvasData {
  name: string;
  path: string;
  activeAtLoad: boolean;
  sortingOrder: number;
  scaler: { referenceResolution: Vec2; screenMatchMode: string; matchWidthOrHeight: number; referencePixelsPerUnit: number } | null;
  root: MenuNodeData;
}
export interface ThemePreviewData {
  theme: 'Default' | 'Neon_City' | 'Forest' | 'Desert' | 'Town';
  displayName: string;
  tableBackground: string | null;
  board: string | null;
}

export const MENU_DATA = menuJson as unknown as {
  canvases: MenuCanvasData[];
  themes: ThemePreviewData[];
  sprites: Record<string, SpriteData & { exportSize?: Vec2 }>;
  fonts: Record<string, FontData>;
  materials: Record<string, MaterialData>;
};

/** A screen's authored data by name. */
export function screenData(name: string): MenuCanvasData | undefined {
  return MENU_DATA.canvases.find((c) => c.name === name);
}

/** The authored node at a full path ("MainMenu/Center/Btn_Tables"), names may contain '/'. */
export function nodeDataAt(path: string): MenuNodeData | null {
  for (const c of MENU_DATA.canvases) {
    if (path === c.root.path) return c.root;
    if (!path.startsWith(c.root.path + '/')) continue;
    const walk = (n: MenuNodeData): MenuNodeData | null => {
      if (n.path === path) return n;
      for (const k of n.children ?? []) if (path === k.path || path.startsWith(k.path + '/')) {
        const hit = walk(k);
        if (hit) return hit;
      }
      return null;
    };
    return walk(c.root);
  }
  return null;
}

export function scriptOf(d: MenuNodeData, name: string): ScriptData | undefined {
  return d.components?.other?.find((o): o is ScriptData => typeof o === 'object' && o.script === name);
}
