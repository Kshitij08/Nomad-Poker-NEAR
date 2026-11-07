// Runs in a host tab of the dev server: makes a 1280x720 same-origin iframe of the app (?paused=1), plays the offline
// table with seed 55 / bot think 1 s on fixed 1/60 s frames, and posts the shots to the local receiver (port 5199).
(() => {
  const THEME = 'Town';
  const RX = 'http://127.0.0.1:5199/save?name=';
  const SHOTS = [
    ['00-hand-start', 'HandStartedEvent', 0, 0.05], ['01-deal-a', 'HoleCardsDealtEvent', 0, 0.2], ['02-deal-b', 'HoleCardsDealtEvent', 3, 0.2],
    ['03-deal-c', 'HoleCardsDealtEvent', 6, 0.25], ['04-cards-landed', 'HoleCardsDealtEvent', 6, 2.0], ['05-fold-grey', 'PlayerActedEvent', 0, 0.5],
    ['06-flop-a', 'CommunityDealtEvent', 0, 0.15], ['07-flop-b', 'CommunityDealtEvent', 0, 0.35], ['08-flop-c', 'CommunityDealtEvent', 0, 0.7],
    ['09-flop-d', 'CommunityDealtEvent', 0, 2.0], ['10-turn-a', 'CommunityDealtEvent', 1, 0.35], ['11-turn-b', 'CommunityDealtEvent', 1, 2.0],
    ['12-river-a', 'CommunityDealtEvent', 2, 0.35], ['13-river-b', 'CommunityDealtEvent', 2, 1.0], ['14-river-c', 'CommunityDealtEvent', 2, 1.2],
    ['15-river-d', 'CommunityDealtEvent', 2, 1.3], ['16-river-e', 'CommunityDealtEvent', 2, 1.5], ['17-river-f', 'CommunityDealtEvent', 2, 3.0],
    ['18-showdown-a', 'ShowdownEvent', 0, 0.15], ['19-showdown-b', 'ShowdownEvent', 0, 0.4], ['20-showdown-c', 'ShowdownEvent', 0, 1.5],
    ['21-award-a', 'PotAwardedEvent', 0, 0.15], ['22-award-b', 'PotAwardedEvent', 0, 0.35], ['23-award-c', 'PotAwardedEvent', 0, 0.7],
    ['24-award-d', 'PotAwardedEvent', 0, 1.5], ['25-return-a', 'HandEndedEvent', 0, 0.15], ['26-return-b', 'HandEndedEvent', 0, 0.35],
    ['27-return-c', 'HandEndedEvent', 0, 0.7], ['28-return-d', 'HandEndedEvent', 0, 1.5],
  ];
  const VIEW_TO_EVENT = {
    beginHand: 'HandStartedEvent', showBlind: 'BlindPostedEvent', showHoleCards: 'HoleCardsDealtEvent', showAction: 'PlayerActedEvent',
    showBoard: 'CommunityDealtEvent', showShowdown: 'ShowdownEvent', showPotAward: 'PotAwardedEvent', endHand: 'HandEndedEvent',
  };
  const st = (window.__parity = { phase: 'start', shots: 0, frame: 0, log: [] });
  const post = (name, body) => fetch(RX + encodeURIComponent(name), { method: 'POST', body });

  async function run() {
    document.getElementById('__parityFrame')?.remove();
    const f = document.createElement('iframe');
    f.id = '__parityFrame';
    // srcdoc copy of the app without the Vite client: other people's edits must not hot-reload it mid-run
    let html = await (await fetch('/')).text();
    html = html.replace('<script type="module" src="/@vite/client"></script>', '').replace('<head>', '<head><script>window.WebSocket=function(){return{addEventListener(){},removeEventListener(){},send(){},close(){},readyState:0}};</script>');
    f.srcdoc = html;
    f.style.cssText = 'position:fixed;left:0;top:0;width:1280px;height:720px;border:0;opacity:0;pointer-events:none;z-index:-1';
    document.body.appendChild(f);
    const w = f.contentWindow;
    for (let i = 0; i < 600 && !(w.__poker && w.document.getElementById('screens')?.children.length); i++) await new Promise((r) => setTimeout(r, 100));
    st.phase = 'booted';
    const yieldMacro = () => new Promise((r) => { const ch = new w.MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });
    const P = w.__poker;
    P.pause(true);
    const lib = (await import('http://127.0.0.1:5199/html-to-image.js')).default;
    const theme = P.ctx.services.theme; theme.applyTableSkin(THEME);
    await P.ctx.router.navigate('table', { settings: { useFixedSeed: true, seed: 55, botThinkMin: 1, botThinkMax: 1 } });
    theme.applyTableSkin(THEME);
    st.theme = theme.current;
    const ctrl = w.__controller;
    st.settings = JSON.stringify(ctrl.settings);
    let frame = 0, handFrame = -1;
    const anchors = {};
    const timeline = ['frame\tt\tevent\tdetail'];
    const view = ctrl.view;
    for (const [m, ev] of Object.entries(VIEW_TO_EVENT)) {
      const orig = view[m].bind(view);
      view[m] = (...args) => {
        if (ev === 'HandStartedEvent' && handFrame < 0) handFrame = frame;
        if (handFrame >= 0) {
          // one ShowdownEvent presents every entry: count the first call per frame only
          const list = (anchors[ev] ??= []);
          if (!(ev === 'ShowdownEvent' && list.length && list[list.length - 1] === frame)) list.push(frame);
          const rf = frame - handFrame;
          timeline.push(`${rf}\t${(rf / 60).toFixed(3)}\t${ev}\t${JSON.stringify(args).slice(0, 160)}`);
        }
        return orig(...args);
      };
    }
    const done = new Array(SHOTS.length).fill(false);
    const shotLog = ['shot\tanchorFrame\tframe\tt'];
    const hud = w.document.getElementById('hud');
    const screens = w.document.getElementById('screens');
    const canvas = w.document.getElementById('table3d');
    st.canvas = `${canvas.width}x${canvas.height} dpr ${w.devicePixelRatio} inner ${w.innerWidth}x${w.innerHeight}`;
    let fontCss = null;
    st.phase = 'running';
    while (frame < 60 * 150) {
      P.stage.advance(1 / 60);
      frame++;
      await yieldMacro();
      if (handFrame < 0) continue;
      const rel = frame - handFrame;
      let all = true;
      for (let i = 0; i < SHOTS.length; i++) {
        if (done[i]) continue;
        const [name, ev, idx, off] = SHOTS[i];
        const fr = anchors[ev];
        if (fr && fr.length > idx && rel >= fr[idx] - handFrame + Math.round(off * 60)) {
          P.stage.render();
          const base = canvas.toDataURL('image/png'); // same task as the render: the drawing buffer is still there
          fontCss ??= await lib.getFontEmbedCSS(hud);
          const opts = { width: 1280, height: 720, pixelRatio: 1, fontEmbedCSS: fontCss, cacheBust: false };
          const hudPng = await lib.toPng(hud, opts);
          const scrPng = await lib.toPng(screens, opts);
          await post(`${name}__3d.png`, base);
          await post(`${name}__hud.png`, hudPng);
          await post(`${name}__screens.png`, scrPng);
          shotLog.push(`${name}\t${fr[idx] - handFrame}\t${rel}\t${(rel / 60).toFixed(3)}`);
          done[i] = true;
          st.shots++;
          continue;
        }
        all = false;
      }
      st.frame = rel;
      if (all) break;
    }
    await post('timeline.tsv', timeline.join('\n') + '\n');
    await post('shots.tsv', shotLog.join('\n') + '\n');
    st.phase = 'done';
  }
  run().catch((e) => { st.phase = 'error'; st.error = String(e && e.stack || e); });
  return 'started';
})();
