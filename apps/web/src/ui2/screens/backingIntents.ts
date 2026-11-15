/**
 * Agents › Back a pro › "From another chain": a live NEAR Intents price for backing an agent with USDC, ETH, SOL, BTC
 * and others from their own chains. 1Click quotes are mainnet prices and this app runs on NEAR testnet, so it shows
 * the quote (refreshed every 20 s) and leaves the fund button off; testnet backing goes through the NEAR flow.
 */
import { formatNear } from '../../near/backing';
import { listTokens, origins, quote, timeWords, toBaseUnits, type Origin, type Quote } from '../../near/intents';
import { btn, chips, esc } from '../core';
import { friendlyError, ui } from '../ctx';

const REFRESH_MS = 20_000;
const TYPING_MS = 450;
/** A sensible first amount per asset (about $25). */
const START: Record<string, string> = { USDC: '25', USDT: '25', ETH: '0.01', SOL: '0.5', BTC: '0.0005', DOGE: '250' };

const st = {
  agent: '',
  origins: null as Origin[] | null,
  loadError: '',
  chain: 'base',
  symbol: 'USDC',
  amount: START.USDC!,
  quote: null as Quote | null,
  quoteError: '',
  loading: false,
  updated: 0,
  seq: 0,
  timer: 0,
  typingTimer: 0,
};

let listening = false;

const picked = (): Origin | undefined => st.origins?.find((o) => o.chain === st.chain && o.symbol === st.symbol);
const isOpen = (): boolean => !!document.getElementById('ix-root');

function quoteHtml(): string {
  if (st.loadError) return `<div class="v2-sm v2-badc">${esc(st.loadError)}</div>${btn('Try again', 'ix-retry', { h: 'ghost', c: 'sm' })}`;
  if (!st.origins) return `<div class="v2-sm v2-mut">Loading chains…</div>`;
  if (st.quoteError) return `<div class="v2-sm v2-badc">${esc(st.quoteError)}</div>`;
  const q = st.quote;
  if (!q) return `<div class="v2-sm v2-mut">${st.loading ? 'Getting a live price…' : 'Enter an amount to see how much NEAR arrives.'}</div>`;
  const costPct = q.amountInUsd > 0 ? (q.costUsd / q.amountInUsd) * 100 : 0;
  const rows = [
    ['At least', `${formatNear(q.minAmountOut)} NEAR`],
    ['Arrives in', timeWords(q.seconds)],
    ['Fees and price impact', `$${q.costUsd.toFixed(2)} (${costPct.toFixed(1)}%)`],
  ]
    .map(([k, v]) => `<div class="v2-row"><span class="v2-grow v2-mut">${k}</span><b>${v}</b></div>`)
    .join('');
  const when = new Date(st.updated).toLocaleTimeString();
  return `<div><b style="font-size:1.6em">≈ ${formatNear(q.amountOut, 3)} NEAR</b> <span class="v2-sm v2-mut">($${q.amountOutUsd.toFixed(2)}) into ${esc(st.agent)}'s pool</span></div><div class="v2-col v2-sm" style="gap:.25em;margin-top:.4em">${rows}</div><div class="v2-xs v2-mut" style="margin-top:.4em">${st.loading ? 'Updating…' : `Price at ${esc(when)}, updates every 20 s.`}${q.feeBps ? ` Includes NEAR Intents' ${(q.feeBps / 100).toFixed(1)}% fee.` : ''}</div>`;
}

function body(): string {
  const list = st.origins ?? [];
  const chains = [...new Map(list.map((o) => [o.chain, o.chainName])).entries()];
  const assets = list.filter((o) => o.chain === st.chain).map((o): [string, string] => [o.symbol, o.symbol]);
  const pickers = list.length
    ? `<div class="v2-xs v2-mut">From</div><div class="v2-row v2-wrap" style="gap:.35em">${chips(chains, st.chain, 'ix-chain')}</div><div class="v2-row v2-wrap" style="gap:.35em">${chips(assets, st.symbol, 'ix-asset')}</div><div class="v2-row" style="gap:.5em"><input class="v2-field v2-grow" id="ix-amt" inputmode="decimal" maxlength="24" value="${esc(st.amount)}" placeholder="Amount" autocomplete="off" spellcheck="false"><b>${esc(st.symbol)}</b></div>`
    : '';
  return `<div class="v2-col" id="ix-root" style="gap:.6em"><div class="v2-sm">Pay from another chain and NEAR Intents swaps it to NEAR for ${esc(st.agent)}'s pool.</div>${pickers}<div class="v2-card" id="ix-quote">${quoteHtml()}</div><div class="v2-xs v2-mut">This is a live mainnet price. Nomad runs on NEAR testnet, so funding from another chain is off for now. You can back with testnet NEAR today.</div></div>`;
}

/** Shows the latest quote: patches the quote box while the amount field has focus (renders wait for it), else renders. */
function paint(): void {
  const box = document.getElementById('ix-quote');
  if (box) box.innerHTML = quoteHtml();
  ui().render();
}

async function refresh(): Promise<void> {
  if (!isOpen()) return stop();
  const o = picked();
  if (!o) return;
  const seq = ++st.seq;
  let amount: bigint;
  try {
    amount = st.amount.trim() ? toBaseUnits(st.amount, o.token.decimals) : 0n;
  } catch (e) {
    st.quote = null;
    st.quoteError = (e as Error).message;
    return paint();
  }
  if (amount <= 0n) {
    st.quote = null;
    st.quoteError = '';
    return paint();
  }
  st.loading = true;
  st.quoteError = '';
  paint();
  try {
    const q = await quote(o.token, amount);
    if (seq !== st.seq) return;
    st.quote = q;
    st.updated = Date.now();
  } catch (e) {
    if (seq !== st.seq) return;
    st.quote = null;
    st.quoteError = friendlyError(e, "Couldn't get a price from NEAR Intents. Try again.");
  } finally {
    if (seq === st.seq) {
      st.loading = false;
      paint();
    }
  }
}

function stop(): void {
  window.clearInterval(st.timer);
  window.clearTimeout(st.typingTimer);
  st.timer = 0;
}

async function loadOrigins(): Promise<void> {
  st.loadError = '';
  paint();
  try {
    st.origins = origins(await listTokens());
    if (!picked() && st.origins[0]) ({ chain: st.chain, symbol: st.symbol } = st.origins[0]);
  } catch (e) {
    st.loadError = friendlyError(e, "Couldn't reach NEAR Intents. Check your connection and try again.");
  }
  paint();
  void refresh();
}

function onTyping(e: Event): void {
  const el = e.target as HTMLInputElement;
  if (el?.id !== 'ix-amt') return;
  st.amount = el.value;
  window.clearTimeout(st.typingTimer);
  st.typingTimer = window.setTimeout(() => void refresh(), TYPING_MS);
}

/** Opens the "From another chain" quote for `agentId`; `backWithNear` opens the testnet NEAR flow instead. */
export function openCrossChain(agentId: string, backWithNear: () => void): void {
  st.agent = agentId;
  st.quote = null;
  st.quoteError = '';
  st.seq++;
  if (!listening) {
    ui().el.addEventListener('input', onTyping);
    listening = true;
  }
  const chainName = (): string => picked()?.chainName ?? 'another chain';
  ui().openDialog({
    title: `Stake on ${esc(agentId)} from another chain`,
    wide: true,
    body,
    get buttons() {
      return btn('Stake with NEAR', 'ix-near', { h: 'ghost' }) + btn(`Fund from ${esc(chainName())}`, 'ix-fund', { h: 'gold', dis: true, title: 'Mainnet only: Nomad runs on NEAR testnet' });
    },
    actions: {
      'ix-chain': (v) => {
        st.chain = v;
        const first = st.origins?.find((o) => o.chain === v);
        if (first && !picked()) st.symbol = first.symbol;
        st.amount = START[st.symbol] ?? '1';
        st.quote = null;
        void refresh();
      },
      'ix-asset': (v) => {
        st.symbol = v;
        st.amount = START[v] ?? '1';
        st.quote = null;
        void refresh();
      },
      'ix-retry': () => void loadOrigins(),
      'ix-near': () => {
        stop();
        ui().closeDialog();
        backWithNear();
      },
    },
  });
  stop();
  st.timer = window.setInterval(() => void refresh(), REFRESH_MS);
  if (st.origins) void refresh();
  else void loadOrigins();
}

