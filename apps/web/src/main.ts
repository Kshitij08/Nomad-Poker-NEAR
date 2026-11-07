import { Clock, SRGBColorSpace, WebGLRenderer } from 'three';
import { ticker } from './anim/tween';
import { buildTableScene } from './three/tableScene';
import { CardModelVisual, preloadCardTextures } from './three/cardModel';
import { SplineCardDealer } from './table/splineCardDealer';
import { TableView, tickerWait } from './table/tableView';
import { createTableHud } from './hud/tableHud';
import { PokerGameController, TEST_SCENE_TABLE_SETTINGS } from './core';
import { WebAudio } from './audio/webAudio';
import type { CardFace } from './table/cardView';
import { createRiverSlam } from './table/riverSlam';
import { LensDistortionRenderer } from './three/lensDistortion';
import { watchActivationSmoke } from './three/impactSmoke';
import { PotTokens } from './three/potTokens';
import sceneData from './data/unity-scene.json';
import type { PotHud } from './table/tableView';

const params = new URLSearchParams(location.search);

const canvas = document.getElementById('table3d') as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.outputColorSpace = SRGBColorSpace;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const table = buildTableScene();
preloadCardTextures();
const lens = new LensDistortionRenderer(renderer);

const hudRoot = document.getElementById('hud')!;
const hud = createTableHud(hudRoot, table.camera);

// The river slam (MMF_Player on PokerController/RiverSlamFeedback). Channel 1 shakes the seat name tags.
let dealtRoot: { children: readonly import('three').Object3D[] } | null = null;
const slam = createRiverSlam({
  camera: table.camera,
  slotRoots: table.slots.map((s) => s.root),
  getHoleCards: () => dealtRoot?.children ?? [],
  world: table.world,
  lens,
  onNameTagShake: (shake) => {
    if (shake.kind !== 'rotation') return;
    hud.seats.forEach((seat, i) => {
      if (!seat.visible) return;
      shake.play(`seat${i}`, (off) => {
        seat.canvas.eulerOffset = off.x || off.y || off.z ? { x: off.x, y: off.y, z: off.z } : null;
      });
    });
  },
});

const dealer = new SplineCardDealer(table.world, () => new CardModelVisual(), table.slots, slam, {
  dealSpeed: table.dealer.dealSpeed,
  holeStagger: table.dealer.holeStagger,
  cardOptions: table.cardOptions,
});
dealtRoot = dealer.dealtRoot;

// Slot_4's reveal clip toggles its impact smoke on; play the burst whenever it activates.
const smokeNode = table.slots[3]?.root.getObjectByName('VFX_Impact_Smoke');
if (smokeNode) watchActivationSmoke(smokeNode);

ticker.timeScale = Number(params.get('speed') ?? 1);
// PotView = the pot pill (DOM) + the 3D token piles. Tokens fly to the winning SeatView's transform.
const potTokens = new PotTokens(table.world);
const seatWorld = sceneData.splines.map((s) => s.seatRootWorldPosition);
const pot: PotHud = {
  setPot(value) {
    hud.pot.setPot(value);
    potTokens.setPot(value);
  },
  setMessage(message) {
    hud.pot.setMessage(message);
  },
  awardTokensTo(seat) {
    hud.pot.awardTokensTo(seat);
    if (seatWorld[seat]) potTokens.awardTokensTo(seatWorld[seat]);
  },
};
const view = new TableView({ seats: hud.seats, betting: hud.betting, pot }, dealer, table.seatSplines);

let controller: PokerGameController | null = null;
if (params.get('demo') === '1') runDemoHand();
else {
  const audio = new WebAudio();
  void audio.load();
  controller = new PokerGameController(TEST_SCENE_TABLE_SETTINGS, view, audio, { wait: tickerWait });
  void controller.start();
}

/** ?demo=1: scripted hand that exercises every card animation without the engine. */
function runDemoHand(): void {
  dealer.clear();
  const deck: CardFace[] = [];
  for (let suit = 0; suit < 4; suit++) for (let rank = 2; rank <= 14; rank++) deck.push({ rank, suit });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const hands = table.seatSplines.map(() => [deck.pop()!, deck.pop()!] as const);
  const board = deck.splice(0, 5);
  table.seatSplines.forEach(([s0, s1], seat) => dealer.dealHoleCards(seat, s0, s1, hands[seat][0], hands[seat][1], seat === 0));
  const at = (t: number, fn: () => void) => ticker.delayedCall(t, fn);
  at(4.0, () => dealer.greyOutHoleCards(3));
  at(4.5, () => dealer.dealCommunity(board.slice(0, 3), board.slice(0, 3)));
  at(6.5, () => dealer.dealCommunity(board.slice(3, 4), board.slice(0, 4)));
  at(9.0, () => dealer.dealCommunity(board.slice(4, 5), board));
  at(11.0, () => [1, 5].forEach((s) => dealer.revealHoleCards(s, hands[s][0], hands[s][1])));
  at(13.5, () => {
    dealer.returnHoleCards();
    dealer.withdrawCommunityCards();
  });
  at(16.5, runDemoHand);
}

/** Advances the whole table by `seconds` in fixed 1/60 s steps (with ?paused=1, for frame inspection). */
function step(seconds: number): void {
  const frames = Math.round(seconds * 60);
  for (let i = 0; i < frames; i++) {
    ticker.update(1 / 60);
    table.update((1 / 60) * ticker.timeScale);
  }
  hud.update();
  lens.render(table.scene, table.camera);
}
let paused = params.get('paused') === '1';

(window as unknown as Record<string, unknown>).__poker = { table, dealer, ticker, view, controller, hud, slam, lens, potTokens, step, pause: (p: boolean) => (paused = p) };

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  table.camera.aspect = w / h;
  table.camera.updateProjectionMatrix();
  hud.layout();
}
window.addEventListener('resize', resize);
resize();

const clock = new Clock();
renderer.setAnimationLoop(() => {
  const raw = Math.min(clock.getDelta(), 0.1);
  if (!paused) {
    ticker.update(raw);
    table.update(raw * ticker.timeScale);
  }
  hud.update();
  lens.render(table.scene, table.camera);
});
