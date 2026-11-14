/**
 * The support page (admin.html): find a player, see their account, adjust a balance, ban or unban, and read the
 * ledger reconciliation, integrity leads and the audit log. A front end for the API's `/v1/admin/*` routes, which
 * check the admin role on every call; this page only decides what to show. It uses the game's sign-in in this
 * browser, so sign in to the game first. Everything a player typed (names, reasons) is shown as text, never HTML.
 */
import { CURRENCIES, type Currency } from '@nomad/contract';
import { AdminApi, AdminError, adjustProblem, sessionKey, signed, type AdminRole, type PlayerDetail } from './api';

const PRESETS: Record<string, string> = {
  staging: 'https://nomad-poker-near-api-staging.kshitijiitgn.workers.dev',
  production: 'https://nomad-poker-near-api.kshitijiitgn.workers.dev',
  local: 'http://localhost:8788',
};

function apiBase(): string | null {
  const env = import.meta.env as Record<string, string | undefined>;
  // ?api=staging|local is for this page on the dev server only; a deployed build always uses its own API.
  const preset = env.DEV ? PRESETS[new URLSearchParams(location.search).get('api') ?? ''] : undefined;
  return preset ?? env.VITE_API_URL ?? (env.DEV ? PRESETS.staging : null) ?? null;
}

// ------------------------------------------------------------------------------ tiny DOM helpers

type Child = Node | string | number | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'number' ? String(c) : c);
  return el;
}
const when = (t: number | string) => new Date(t).toLocaleString();
const friendId = (c: string | null) => (c ? c.match(/.{1,4}/g)!.join('-') : '—');
const errText = (e: unknown) => (e instanceof AdminError ? e.message : (e as Error)?.message ?? String(e));
function table(head: string[], rows: Child[][]): HTMLElement {
  if (rows.length === 0) return h('div', { class: 'empty' }, 'None.');
  return h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ...head.map((x) => h('th', {}, x)))), h('tbody', {}, ...rows.map((r) => h('tr', {}, ...r.map((c) => (c instanceof HTMLTableCellElement ? c : h('td', {}, c))))))));
}
const num = (n: number) => h('td', { class: 'num' }, n.toLocaleString('en-US'));
const delta = (n: number) => h('td', { class: `num ${n > 0 ? 'plus' : n < 0 ? 'minus' : ''}` }, signed(n));

// ------------------------------------------------------------------------------ page

const root = document.getElementById('admin')!;
const base = apiBase();
let token: string | null = null;
try {
  token = base ? localStorage.getItem(sessionKey(base)) : null;
} catch {
  token = null;
}
const api = new AdminApi(base ?? '', token);
const stage = !base ? 'none' : /localhost|127\.0\.0\.1/.test(base) ? 'local' : base.includes('staging') ? 'staging' : 'production';

let role: AdminRole = 'support';
let myId = '';

function bar(who: string): HTMLElement {
  return h('header', { class: 'bar' }, h('h1', {}, 'Nomad Poker · Admin'), h('span', { class: `stage ${stage}` }, stage), h('span', { class: 'who' }, who));
}

function gate(title: string, ...body: Child[]): void {
  root.replaceChildren(bar(''), h('main', {}, h('div', { class: 'panel center' }, h('h2', {}, title), ...body)));
}

async function start(): Promise<void> {
  if (!base) return gate('No API configured', h('p', {}, 'This build has no API address (VITE_API_URL).'));
  if (!token)
    return gate('Sign in first', h('p', {}, 'This page uses your game sign-in in this browser. Open the game, sign in with the account that is an admin, then come back.'), h('a', { class: 'btn primary', href: '/' }, 'Open the game'));
  let name = '';
  try {
    const me = await api.me();
    name = me.player.displayName;
    myId = me.player.id;
    const w = await api.whoAmI();
    role = w.role;
  } catch (e) {
    if (e instanceof AdminError && e.code === 'not_admin') {
      const cmd = `node infra/add-admin.mjs ${stage === 'production' ? 'production' : 'staging'} ${myId}`;
      return gate(
        'Not an admin',
        h('p', {}, 'You are signed in as ', h('b', {}, name), ' (player ', h('code', {}, myId), '), which is not an admin account.'),
        h('p', { class: 'muted' }, 'Admins are added by an operator, not from this page. To make this account one, run this in the nomad-poker repo:'),
        h('pre', {}, cmd),
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => void navigator.clipboard?.writeText(cmd) }, 'Copy command'), h('button', { class: 'btn', onclick: () => location.reload() }, 'Check again')),
      );
    }
    if (e instanceof AdminError && e.status === 401)
      return gate('Sign in again', h('p', {}, 'Your game session has ended. Sign in to the game again, then come back.'), h('a', { class: 'btn primary', href: '/' }, 'Open the game'));
    return gate("Couldn't load", h('p', { class: 'notice bad' }, errText(e)), h('button', { class: 'btn', onclick: () => location.reload() }, 'Try again'));
  }

  const tabs: [string, string, () => HTMLElement][] = [
    ['players', 'Players', playersTab],
    ['health', 'Ledger health', healthTab],
    ['integrity', 'Integrity', integrityTab],
    ['audit', 'Audit log', auditTab],
  ];
  const nav = h('nav', { class: 'tabs', role: 'tablist' });
  const main = h('main');
  const show = (key: string) => {
    for (const b of nav.querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.key === key));
    main.replaceChildren(tabs.find((t) => t[0] === key)![2]());
    history.replaceState(null, '', `#${key}`);
  };
  for (const [key, label] of tabs) {
    const b = h('button', { role: 'tab', onclick: () => show(key) }, label);
    b.dataset.key = key;
    nav.append(b);
  }
  openPlayer = (id: string) => {
    show('players');
    void loadPlayer(id);
  };
  root.replaceChildren(bar(`${name} · ${role}`), nav, main);
  show(tabs.some((t) => t[0] === location.hash.slice(1)) ? location.hash.slice(1) : 'players');
}

let openPlayer: (id: string) => void = () => {};
const playerLink = (id: string) => h('button', { class: 'linkish mono', onclick: () => openPlayer(id) }, id);

// ------------------------------------------------------------------------------ Players

let searchBox: HTMLInputElement | null = null;
let hitsEl: HTMLElement | null = null;
let detailEl: HTMLElement | null = null;
let lastQuery = '';
let currentId: string | null = null;

function playersTab(): HTMLElement {
  searchBox = h('input', { type: 'search', placeholder: 'Name, Friend ID or player id', 'aria-label': 'Find a player', value: lastQuery });
  hitsEl = h('ul', { class: 'hits' });
  detailEl = h('div', {}, h('div', { class: 'panel' }, h('div', { class: 'empty' }, 'Find a player, then pick them from the list.')));
  const form = h(
    'form',
    { class: 'row', onsubmit: (ev: Event) => (ev.preventDefault(), void search(searchBox!.value)) },
    searchBox,
    h('button', { class: 'btn primary', type: 'submit' }, 'Find'),
  );
  if (lastQuery) void search(lastQuery);
  if (currentId) void loadPlayer(currentId);
  return h('div', { class: 'players' }, h('section', { class: 'panel' }, h('h2', {}, 'Find a player'), form, hitsEl), detailEl);
}

async function search(q: string): Promise<void> {
  lastQuery = q.trim();
  if (!hitsEl || !lastQuery) return;
  hitsEl.replaceChildren(h('li', { class: 'empty' }, 'Searching…'));
  try {
    const { players } = await api.search(lastQuery);
    hitsEl.replaceChildren(
      ...(players.length
        ? players.map((p) =>
            h(
              'li',
              {},
              h(
                'button',
                { onclick: () => void loadPlayer(p.id), 'aria-current': String(p.id === currentId) },
                h('span', { class: 'name' }, p.name),
                h('span', {}, p.banned ? h('span', { class: 'tag bad' }, 'banned') : null, ' ', h('span', { class: 'tag' }, p.kind)),
              ),
            ),
          )
        : [h('li', { class: 'empty' }, 'No player matches. Names match from the start; Friend IDs and player ids must be whole.')]),
    );
  } catch (e) {
    hitsEl.replaceChildren(h('li', { class: 'notice bad' }, errText(e)));
  }
}

async function loadPlayer(id: string, note?: { ok: boolean; text: string }): Promise<void> {
  currentId = id;
  if (!detailEl) return;
  for (const b of hitsEl?.querySelectorAll('button') ?? []) b.setAttribute('aria-current', 'false');
  detailEl.replaceChildren(h('div', { class: 'panel' }, h('div', { class: 'empty' }, 'Loading…')));
  try {
    const d = await api.player(id);
    if (currentId === id) detailEl.replaceChildren(...playerView(d, note));
  } catch (e) {
    detailEl.replaceChildren(h('div', { class: 'panel' }, h('div', { class: 'notice bad' }, errText(e))));
  }
}

function playerView(d: PlayerDetail, note?: { ok: boolean; text: string }): HTMLElement[] {
  const p = d.player;
  const head = h(
    'section',
    { class: 'panel' },
    h('h2', {}, p.name, ' ', h('span', { class: 'tag' }, p.kind), ' ', p.banned ? h('span', { class: 'tag bad' }, 'banned') : null, p.id === myId ? h('span', { class: 'tag good' }, 'you') : null),
    note ? h('div', { class: `notice ${note.ok ? 'good' : 'bad'}` }, note.text) : null,
    h(
      'dl',
      { class: 'facts' },
      h('dt', {}, 'Player id'), h('dd', { class: 'mono' }, p.id),
      h('dt', {}, 'Friend ID'), h('dd', { class: 'mono' }, friendId(p.friendCode)),
      h('dt', {}, 'Joined'), h('dd', {}, when(p.createdAt)),
      h('dt', {}, 'Last seen'), h('dd', {}, when(p.lastSeen)),
      p.banned ? h('dt', {}, 'Ban reason') : null, p.banned ? h('dd', {}, p.banReason ?? '—') : null,
      h('dt', {}, 'Sign-ins'),
      h('dd', {}, d.identities.length ? d.identities.map((i) => `${i.provider}: ${i.subject}`).join(' · ') : 'guest only'),
    ),
    h('h3', {}, 'Balances'),
    h('div', { class: 'balances' }, ...CURRENCIES.map((c) => h('div', {}, h('b', {}, (d.balances[c] ?? 0).toLocaleString('en-US')), h('span', {}, c.replace('_', ' '))))),
  );

  const actions = h('section', { class: 'panel' }, h('h2', {}, 'Actions'));
  if (role === 'admin') actions.append(adjustForm(d));
  else actions.append(h('p', { class: 'muted' }, 'Balance adjustments need the admin role; support can look up, ban and unban.'));
  actions.append(banForm(d));

  const where = h(
    'section',
    { class: 'panel' },
    h('h2', {}, 'Where they are'),
    h('h3', {}, 'Table seat'),
    d.seat ? table(['Room', 'Table', 'Stack', 'Buy-in', 'Since'], [[d.seat.room, h('span', { class: 'mono' }, d.seat.table_id), num(d.seat.stack), num(d.seat.buy_in), when(d.seat.updated_at)]]) : h('div', { class: 'empty' }, 'Not seated.'),
    h('h3', {}, 'Agents'),
    table(['Agent', 'Phase', 'Room', 'Stack', 'Bankroll', 'Hands'], d.agents.map((a) => [h('span', { class: 'mono' }, a.id), a.phase, a.room, num(a.stack), num(a.bankroll), num(a.hands_played)])),
    h('h3', {}, 'Tournaments'),
    table(['Tournament', 'Status', 'Paid', 'Place', 'Prize'], d.tournaments.map((t) => [h('span', { class: 'mono' }, t.tournament_id), t.status, num(t.paid_amount), t.place ?? '—', t.prize === null ? '—' : num(t.prize)])),
  );

  const ledger = h(
    'section',
    { class: 'panel' },
    h('h2', {}, 'Recent ledger'),
    table(['When', 'Currency', 'Change', 'Reason', 'Ref'], d.ledger.map((e) => [when(e.createdAt), e.currency, delta(e.delta), e.reason, h('span', { class: 'mono' }, e.ref ?? '')])),
    h('h3', {}, 'Admin actions on this player'),
    table(['When', 'Admin', 'Action', 'Details'], d.audit.map((a) => [when(a.created_at), h('span', { class: 'mono' }, a.admin_id), a.action, h('span', { class: 'mono' }, a.details)])),
  );
  return [head, actions, where, ledger];
}

function adjustForm(d: PlayerDetail): HTMLElement {
  const currency = h('select', { 'aria-label': 'Currency' }, ...CURRENCIES.map((c) => h('option', { value: c }, c.replace('_', ' '))));
  const amount = h('input', { type: 'number', step: '1', placeholder: 'Amount (− to take away)', 'aria-label': 'Amount', class: 'grow' });
  const reason = h('input', { type: 'text', maxlength: '200', placeholder: 'Reason (recorded)', 'aria-label': 'Reason', class: 'grow' });
  const go = h('button', { class: 'btn primary', type: 'submit' }, 'Adjust');
  const msg = h('div');
  const form = h(
    'form',
    {
      onsubmit: async (ev: Event) => {
        ev.preventDefault();
        const n = Number(amount.value);
        const problem = adjustProblem(currency.value, n, reason.value);
        if (problem) return void msg.replaceChildren(h('div', { class: 'notice bad' }, problem));
        const c = currency.value as Currency;
        if (!confirm(`${signed(n)} ${c} for ${d.player.name}?\nNew balance: ${((d.balances[c] ?? 0) + n).toLocaleString('en-US')}\nReason: ${reason.value.trim()}`)) return;
        go.disabled = true;
        try {
          const r = await api.adjust(d.player.id, c, n, reason.value.trim());
          await loadPlayer(d.player.id, { ok: true, text: `Done: ${signed(n)} ${c}. Balance now ${r.balances[c].toLocaleString('en-US')}.` });
        } catch (e) {
          msg.replaceChildren(h('div', { class: 'notice bad' }, errText(e)));
          go.disabled = false;
        }
      },
    },
    h('h3', {}, 'Adjust a balance'),
    h('div', { class: 'row' }, currency, amount),
    h('div', { class: 'row', style: 'margin-top:8px' }, reason, go),
    msg,
  );
  return form;
}

function banForm(d: PlayerDetail): HTMLElement {
  const msg = h('div');
  if (d.player.banned) {
    const b = h('button', { class: 'btn', type: 'button' }, 'Lift the ban');
    b.addEventListener('click', async () => {
      if (!confirm(`Lift the ban on ${d.player.name}?`)) return;
      b.disabled = true;
      try {
        await api.unban(d.player.id);
        await loadPlayer(d.player.id, { ok: true, text: 'Ban lifted. They can sign in again.' });
      } catch (e) {
        msg.replaceChildren(h('div', { class: 'notice bad' }, errText(e)));
        b.disabled = false;
      }
    });
    return h('div', {}, h('h3', {}, 'Ban'), h('div', { class: 'row' }, b), msg);
  }
  if (d.player.id === myId) return h('div', {}, h('h3', {}, 'Ban'), h('p', { class: 'muted' }, "This is your own account: you can't ban yourself."));
  const reason = h('input', { type: 'text', maxlength: '200', placeholder: 'Reason (recorded)', 'aria-label': 'Ban reason', class: 'grow' });
  const go = h('button', { class: 'btn danger', type: 'submit' }, 'Ban');
  return h(
    'form',
    {
      onsubmit: async (ev: Event) => {
        ev.preventDefault();
        if (reason.value.trim().length < 3) return void msg.replaceChildren(h('div', { class: 'notice bad' }, 'Say why (at least 3 characters). It is recorded.'));
        if (!confirm(`Ban ${d.player.name}? They are signed out everywhere and can't sign in. A seat's stack pays back at the table as usual.`)) return;
        go.disabled = true;
        try {
          await api.ban(d.player.id, reason.value.trim());
          await loadPlayer(d.player.id, { ok: true, text: 'Banned and signed out everywhere.' });
        } catch (e) {
          msg.replaceChildren(h('div', { class: 'notice bad' }, errText(e)));
          go.disabled = false;
        }
      },
    },
    h('h3', {}, 'Ban'),
    h('div', { class: 'row' }, reason, go),
    msg,
  );
}

// ------------------------------------------------------------------------------ Ledger health

function healthTab(): HTMLElement {
  const out = h('div', {}, h('div', { class: 'empty' }, 'Checking every ledger rule over the last 30 days…'));
  const run = async () => {
    out.replaceChildren(h('div', { class: 'empty' }, 'Checking every ledger rule over the last 30 days…'));
    try {
      const r = await api.reconcile();
      out.replaceChildren(
        h('div', { class: `notice ${r.ok ? 'good' : 'bad'}` }, r.ok ? 'Every check holds: the books balance.' : 'Some checks found problems: see below.', h('span', { class: 'muted' }, ` (${when(r.at)})`)),
        ...r.checks.map((c) =>
          h(
            'div',
            { class: 'check' },
            h('span', { class: `tag ${c.ok ? 'good' : 'bad'}` }, c.ok ? 'OK' : 'PROBLEM'),
            h('div', { class: 'what' }, h('b', {}, c.name), h('div', { class: 'muted' }, `${c.note} · ${c.checked.toLocaleString('en-US')} checked`), c.problems.length ? h('pre', {}, JSON.stringify(c.problems, null, 2)) : null),
          ),
        ),
      );
    } catch (e) {
      out.replaceChildren(h('div', { class: 'notice bad' }, errText(e)));
    }
  };
  void run();
  return h(
    'section',
    { class: 'panel' },
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', {}, 'Ledger reconciliation'), h('button', { class: 'btn', onclick: () => void run() }, 'Run again')),
    h('p', { class: 'muted' }, 'Every money rule the ledger must keep (balances match their entries, tables pay back what they took, and so on). The game server also runs this every few minutes and logs any problems.'),
    out,
  );
}

// ------------------------------------------------------------------------------ Integrity

function integrityTab(): HTMLElement {
  const out = h('div', {}, h('div', { class: 'empty' }, 'Loading…'));
  void (async () => {
    try {
      const r = await api.integrity();
      out.replaceChildren(
        h('p', { class: 'muted' }, `Leads to look into, not proof: since ${when(r.since)}. Nobody is banned automatically.`),
        h('h3', {}, `Chip dumping (one way, ${r.rules.minFlow?.toLocaleString('en-US')}+ coins)`),
        table(['From', 'To', 'Coins', 'One way', 'Hands together'], r.chipDumping.map((x) => [playerLink(x.from), playerLink(x.to), num(x.coins), `${Math.round(x.oneWay * 100)}%`, num(x.handsTogether)])),
        h('h3', {}, 'Marathons (18+ hours of play in a day)'),
        table(['Player', 'Hours', 'Hands'], r.marathons.map((x) => [playerLink(x.player), num(x.hoursInLastDay), num(x.hands)])),
        h('h3', {}, 'Robotic timing'),
        table(['Player', 'Decisions', 'Average ms', 'Spread ms'], r.robotic.map((x) => [playerLink(x.player), num(x.decisions), num(x.avgMs), num(x.sdMs)])),
        h('h3', {}, 'Win-rate outliers (150+ big blinds per 100 hands)'),
        table(['Player', 'Hands', 'bb/100'], r.winRateOutliers.map((x) => [playerLink(x.player), num(x.hands), num(x.bb100)])),
      );
    } catch (e) {
      out.replaceChildren(h('div', { class: 'notice bad' }, errText(e)));
    }
  })();
  return h('section', { class: 'panel' }, h('h2', {}, 'Integrity leads'), out);
}

// ------------------------------------------------------------------------------ Audit log

function auditTab(): HTMLElement {
  const body = h('tbody');
  const more = h('button', { class: 'btn', hidden: true }, 'Older');
  let next: number | undefined;
  const msg = h('div');
  const load = async () => {
    more.disabled = true;
    try {
      const r = await api.audit(next);
      for (const e of r.entries)
        body.append(h('tr', {}, h('td', {}, when(e.at)), h('td', {}, playerOrText(e.admin_id)), h('td', {}, e.action), h('td', {}, e.target_id ? playerLink(e.target_id) : '—'), h('td', { class: 'mono' }, JSON.stringify(e.details))));
      next = r.nextBefore;
      more.hidden = next === undefined;
      if (!body.children.length) msg.replaceChildren(h('div', { class: 'empty' }, 'No admin actions yet.'));
    } catch (e) {
      msg.replaceChildren(h('div', { class: 'notice bad' }, errText(e)));
    }
    more.disabled = false;
  };
  more.addEventListener('click', () => void load());
  void load();
  return h(
    'section',
    { class: 'panel' },
    h('h2', {}, 'Audit log'),
    h('p', { class: 'muted' }, 'Every admin action, newest first. Opening a player is recorded too.'),
    h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ...['When', 'Admin', 'Action', 'Player', 'Details'].map((x) => h('th', {}, x)))), body)),
    msg,
    h('div', { class: 'row', style: 'margin-top:10px' }, more),
  );
}
const playerOrText = (id: string) => (id.startsWith('p_') ? playerLink(id) : h('span', { class: 'mono' }, id));

void start();
