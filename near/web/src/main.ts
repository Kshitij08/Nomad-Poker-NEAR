import "@fontsource/fredoka/600.css";
import "@fontsource/fredoka/700.css";
import "@fontsource/nunito/400.css";
import "@fontsource/nunito/700.css";
import "@fontsource/nunito/800.css";
import "./styles.css";
import { CONTRACT, EXPLORER, PRICE_SCALE } from "./config";
import {
  call, currentAccount, earnings, holding, listAgents, onAccount, position, recentSessions, restoreWallet, sessionRecord, signIn, signOut,
  type AgentCard, type SessionRecord, type SessionSummary,
} from "./near";
import { replaySession } from "./poker";
import { TablePlayer } from "./table";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const YOCTO = 10n ** 24n;

/** yoctoNEAR (string or bigint) to "1.2345". */
function near(y: string | bigint, digits = 4): string {
  const v = BigInt(y);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const scaled = (a * 10n ** BigInt(digits) + YOCTO / 2n) / YOCTO;
  const s = scaled.toString().padStart(digits + 1, "0");
  return `${neg ? "-" : ""}${s.slice(0, -digits)}.${s.slice(-digits)}`;
}

function parseNear(text: string): bigint {
  const m = text.trim().match(/^(\d+)(?:\.(\d{1,24}))?$/);
  if (!m) throw new Error("Enter an amount like 0.5");
  return BigInt(m[1]) * YOCTO + BigInt((m[2] ?? "").padEnd(24, "0"));
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function toast(text: string, kind: "info" | "ok" | "error" = "info") {
  const t = $("toast");
  t.textContent = text;
  t.dataset.kind = kind;
  t.classList.add("toast--show");
  clearTimeout((toast as any).timer);
  (toast as any).timer = setTimeout(() => t.classList.remove("toast--show"), kind === "error" ? 9000 : 5000);
}

async function act(pending: string, done: string, fn: () => Promise<unknown>) {
  toast(pending);
  try {
    await fn();
    toast(done, "ok");
    await refresh();
  } catch (e) {
    toast(`${(e as Error).message ?? e}`.slice(0, 220), "error");
  }
}

// ------------------------------------------------------------------------------------------------ wallet

function renderWallet(account: string | null) {
  const w = $("wallet");
  if (!account) {
    w.innerHTML = `<button class="button button--small" id="connect">Connect wallet</button>`;
    $("connect").onclick = () => signIn().catch((e) => toast(e.message ?? "Wallet closed", "error"));
  } else {
    w.innerHTML = `<span class="account" title="${esc(account)}">${esc(account)}</span><button class="link" id="disconnect">Sign out</button>`;
    $("disconnect").onclick = () => signOut();
  }
  $("mine").hidden = !account;
  $("list-agent").hidden = !account;
}

// ------------------------------------------------------------------------------------------------ agents

let agents: AgentCard[] = [];

function style(tight: number, aggro: number) {
  const plays = tight >= 60 ? "Tight" : tight <= 25 ? "Loose" : "Selective";
  const bets = aggro >= 65 ? "aggressive" : aggro <= 35 ? "passive" : "balanced";
  return `<span class="style" title="Plays few hands: ${tight}/100. Bets and raises: ${aggro}/100.">
    <span class="style__dot" style="--t:${tight}; --a:${aggro}"></span>${plays}, ${bets}</span>`;
}

function change(price: string) {
  const pct = (Number(price) / PRICE_SCALE - 1) * 100;
  const cls = pct > 0.05 ? "up" : pct < -0.05 ? "down" : "flat";
  return `<span class="delta delta--${cls}">${pct > 0 ? "+" : ""}${pct.toFixed(1)}%</span>`;
}

async function renderAgents() {
  const list = $("agent-list");
  if (!agents.length) {
    list.innerHTML = `<p class="empty">No agents are listed yet. Connect a wallet and list the first one below.</p>`;
    return;
  }
  const me = currentAccount();
  const stakes = me ? await Promise.all(agents.map((a) => holding(me, a.agent.id).catch(() => null))) : [];
  list.innerHTML = `
    <div class="row row--head" aria-hidden="true">
      <span>Agent</span><span>Plays</span><span>Record</span><span>Pool</span><span>Since start</span><span>Your stake</span><span></span>
    </div>
    ${agents
      .map(({ agent: a, pool: p }, i) => {
        const s = stakes[i];
        const mine = s && BigInt(s.value) > 0n ? `${near(s.value)} NEAR` : s && BigInt(s.pending_in) > 0n ? "Joining after this session" : "—";
        return `
        <article class="row" data-agent="${esc(a.id)}">
          <span class="row__agent"><strong>${esc(a.id)}</strong><small>by ${esc(a.owner)}</small></span>
          <span>${style(a.tight, a.aggro)}</span>
          <span class="num">${a.sessions} sessions<small>${a.hands} hands, ${a.net_chips >= 0 ? "+" : ""}${a.net_chips} chips</small></span>
          <span class="num">${p ? `${near(p.value, 3)} NEAR` : "Empty"}${p && BigInt(p.at_table) > 0n ? `<small>playing now</small>` : ""}</span>
          <span class="num">${p ? change(p.price) : "—"}</span>
          <span class="num">${mine}</span>
          <span><button class="button button--small" data-open="${esc(a.id)}" aria-expanded="false">Back</button></span>
          <div class="drawer" id="drawer-${esc(a.id)}" hidden></div>
        </article>`;
      })
      .join("")}`;

  list.querySelectorAll<HTMLButtonElement>("[data-open]").forEach((b) => {
    b.onclick = () => openDrawer(b.dataset.open!, b);
  });
}

async function openDrawer(agentId: string, button: HTMLButtonElement) {
  const d = $(`drawer-${agentId}`);
  const open = d.hidden;
  document.querySelectorAll<HTMLElement>(".drawer").forEach((x) => (x.hidden = true));
  document.querySelectorAll<HTMLButtonElement>("[data-open]").forEach((x) => x.setAttribute("aria-expanded", "false"));
  if (!open) return;
  d.hidden = false;
  button.setAttribute("aria-expanded", "true");
  const me = currentAccount();
  if (!me) {
    d.innerHTML = `<p>Connect a NEAR wallet to back <strong>${esc(agentId)}</strong>.</p><button class="button button--gold" id="drawer-connect">Connect wallet</button>`;
    $("drawer-connect").onclick = () => signIn().catch(() => undefined);
    return;
  }
  const card = agents.find((a) => a.agent.id === agentId)!;
  const h = await holding(me, agentId);
  const playing = card.pool && BigInt(card.pool.at_table) > 0n;
  d.innerHTML = `
    <form class="back-form" id="join-form">
      <label>Amount to add <span class="input-unit"><input name="amount" inputmode="decimal" placeholder="0.5" required /><span>NEAR</span></span></label>
      <button class="button button--gold" type="submit">Join pool</button>
    </form>
    <p class="hint">${playing ? "The pool is playing a session now. Your NEAR joins at the value it settles at." : "You get pool shares at today's value. At most 25% of the pool plays in any one session."}</p>
    ${BigInt(h.shares) > 0n ? `<p>Your stake is worth <strong>${near(h.value)} NEAR</strong>. <button class="link" id="leave">Leave pool and withdraw it</button></p>` : ""}`;
  ($("join-form") as HTMLFormElement).onsubmit = (e) => {
    e.preventDefault();
    let amount: bigint;
    try {
      amount = parseNear(new FormData(e.target as HTMLFormElement).get("amount") as string);
    } catch (err) {
      return toast((err as Error).message, "error");
    }
    act("Confirm in your wallet to join the pool…", `Joined ${agentId}'s pool.`, () => call("join_pool", { agent_id: agentId }, amount, 30n));
  };
  const leave = document.getElementById("leave");
  if (leave) leave.onclick = () => act("Confirm in your wallet to leave the pool…", playing ? "Leaving after this session settles." : `Left ${agentId}'s pool.`, () => call("leave_pool", { agent_id: agentId, shares: h.shares }, 0n, 50n));
}

// ------------------------------------------------------------------------------------------------ your stakes

async function renderMine() {
  const me = currentAccount();
  if (!me) return;
  const [rows, earned] = await Promise.all([
    Promise.all(agents.map(async ({ agent }) => ({ agent, h: await holding(me, agent.id), p: await position(me, agent.id) }))),
    earnings(me),
  ]);
  const held = rows.filter((r) => BigInt(r.h.shares) > 0n || BigInt(r.h.pending_in) > 0n || (r.p && BigInt(r.p.balance) + BigInt(r.p.at_table) > 0n));
  const box = $("mine-list");
  const lines = held.map(({ agent, h, p }) => {
    const parts = [];
    if (BigInt(h.shares) > 0n) parts.push(`${near(h.value)} NEAR in the pool`);
    if (BigInt(h.pending_in) > 0n) parts.push(`${near(h.pending_in)} NEAR joining after this session`);
    if (p && BigInt(p.balance) + BigInt(p.at_table) > 0n) parts.push(`${near(BigInt(p.balance) + BigInt(p.at_table))} NEAR backed on your own, ${BigInt(p.net) >= 0n ? "up" : "down"} ${near(BigInt(p.net) < 0n ? -BigInt(p.net) : BigInt(p.net))}`);
    return `<li><strong>${esc(agent.id)}</strong><span>${parts.join("; ")}</span></li>`;
  });
  const earn = BigInt(earned) > 0n ? `<p class="earned">Your agents have earned you <strong>${near(earned)} NEAR</strong>. <button class="button button--small button--gold" id="claim">Claim earnings</button></p>` : "";
  box.innerHTML = `${earn}${lines.length ? `<ul class="stakes">${lines.join("")}</ul>` : `<p class="empty">You haven't backed an agent yet. Pick one above.</p>`}`;
  const claim = document.getElementById("claim");
  if (claim) claim.onclick = () => act("Confirm in your wallet to claim…", "Earnings sent to your wallet.", () => call("claim_earnings", {}, 0n, 30n));
}

($("register") as HTMLFormElement).onsubmit = (e) => {
  e.preventDefault();
  const f = new FormData(e.target as HTMLFormElement);
  const id = String(f.get("id")).trim();
  act("Confirm in your wallet to list the agent…", `${id} is listed.`, () =>
    call("register_agent", { agent_id: id, tight: Number(f.get("tight")), aggro: Number(f.get("aggro")) }, 0n, 30n),
  );
};

// ------------------------------------------------------------------------------------------------ table and proof

const player = new TablePlayer($("table"));
let sessions: SessionSummary[] = [];
let watching: string | null = null;

function renderSessions() {
  const box = $("sessions");
  if (!sessions.length) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = `<span class="sessions__label">Recent sessions</span>${sessions
    .map((s) => `<button class="chip${s.session_id === watching ? " chip--on" : ""}" data-session="${esc(s.session_id)}" aria-pressed="${s.session_id === watching}">${esc(s.session_id)}<small>${s.hands} hands</small></button>`)
    .join("")}`;
  box.querySelectorAll<HTMLButtonElement>("[data-session]").forEach((b) => (b.onclick = () => watch(b.dataset.session!)));
}

function renderProof(rec: SessionRecord, matches: boolean, hands: number) {
  const paid = rec.payouts?.seats ?? [];
  $("proof").innerHTML = `
    <h2>How session ${esc(rec.session_id)} was checked</h2>
    <p class="${matches ? "ok" : "bad"}">${matches
      ? `Your browser re-dealt all ${hands} hands from the dealer's randomness proof and replayed every bet. The final stacks match what the contract paid out.`
      : "The replay in your browser does not match the contract's record. Do not trust this session."}</p>
    <dl>
      <dt>Randomness request</dt><dd><code>${esc(rec.alpha)}</code></dd>
      <dt>Proof</dt><dd><code title="${esc(rec.signature_hex)}">${esc(rec.signature_hex.slice(0, 20))}…</code></dd>
    </dl>
    ${paid.length ? `<table class="paid"><caption>Paid out</caption><thead><tr><th>Seat</th><th>Result</th><th>Pro</th><th>Backers</th></tr></thead><tbody>${paid
      .map((p) => {
        const r = BigInt(p.cash_out) - BigInt(p.buy_in);
        return `<tr><th scope="row">${esc(p.agent)}</th><td class="${r > 0n ? "up" : r < 0n ? "down" : ""}">${r > 0n ? "+" : ""}${near(r)}</td><td>${near(p.pro_fee)}</td><td>${near(p.to_backer)}</td></tr>`;
      })
      .join("")}</tbody></table><p class="hint">NEAR. Backers get their buy-in back plus 90% of the profit.</p>` : ""}`;
}

async function watch(id: string) {
  watching = id;
  renderSessions();
  const rec = await sessionRecord(id);
  if (!rec) return;
  const replay = await replaySession({ signature_hex: rec.signature_hex, stacks: rec.stacks, button: rec.button, sb: rec.sb, bb: rec.bb, hands: rec.hands, actions: rec.actions });
  const matches = replay.stacks.join() === rec.end_stacks.join();
  renderProof(rec, matches, replay.hands.length);
  const names = rec.payouts?.seats.map((s) => s.agent) ?? rec.stacks.map((_, i) => `Seat ${i + 1}`);
  await player.play(replay, names);
  // Then the next most recent session, round and round.
  const k = sessions.findIndex((s) => s.session_id === id);
  if (watching === id && sessions.length) watch(sessions[(k + 1) % sessions.length].session_id);
}

// ------------------------------------------------------------------------------------------------ start

async function refresh() {
  agents = await listAgents();
  await renderAgents();
  await renderMine().catch(() => undefined);
}

async function start() {
  ($("contract-link") as HTMLAnchorElement).href = `${EXPLORER}/address/${CONTRACT}`;
  onAccount((a) => {
    renderWallet(a);
    if (agents.length) refresh().catch(() => undefined);
  });
  restoreWallet();
  refresh().catch((e) => ($("agent-list").innerHTML = `<p class="empty">Could not reach NEAR: ${esc(e.message)}. Reload to try again.</p>`));
  sessions = await recentSessions(8).catch(() => []);
  if (sessions.length) watch(sessions[0].session_id).catch((e) => toast(`Replay failed: ${e.message}`, "error"));
  else $("table").insertAdjacentHTML("beforeend", `<p class="empty">No settled sessions yet. The table plays here once an agent session settles.</p>`);
}

start();
