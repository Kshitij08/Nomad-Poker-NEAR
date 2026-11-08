/**
 * PokerClientIdentity / StakeSelection / the HUD wallet for the browser client, read from the economy module when it
 * is installed (src/economy/identity.ts, virtualEconomy.ts) and from the same PlayerPrefs keys as the C# otherwise.
 *
 * Testing several players in one browser: tabs share localStorage, so they would share one identity (and the
 * server would rightly refuse the same account twice). `?netPlayer=Alice` gives a tab its own identity — name, token
 * and account — kept in sessionStorage.
 */
import type { AppContext } from '../app/app';
import { PlayerPrefs, type VirtualWallet } from '../app/services';
import { clampBuyIn, StakeCatalog, type StakeTier } from '@nomad/engine/stakes/stakes';
import { PokerClientIdentity } from '../economy/identity';
import { VirtualEconomy } from '../economy/virtualEconomy';
import type { ClientIdentity, WalletPort } from './clientGame';

interface TabIdentity {
  name: string;
  token: string;
  playerId: string;
}

function tabIdentity(params: URLSearchParams): TabIdentity | null {
  const name = params.get('netPlayer');
  if (!name) return null;
  const key = `Poker.Net.Tab.${name}`;
  try {
    const saved = sessionStorage.getItem(key);
    if (saved) return JSON.parse(saved) as TabIdentity;
  } catch {
    /* blocked storage: derive below */
  }
  const id = name.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'tab';
  const t: TabIdentity = { name: name.slice(0, 24), token: `tab-${id}-${crypto.randomUUID().slice(0, 8)}`, playerId: `tab-${id}` };
  try {
    sessionStorage.setItem(key, JSON.stringify(t));
  } catch {
    /* ignore */
  }
  return t;
}

/** The HUD wallet: VirtualEconomy (the economy module's), else the shell's wallet service, else a local number. */
export function browserWallet(ctx: AppContext): WalletPort {
  const fallback = { coins: 10_000 };
  const wallet = (): VirtualWallet | null => {
    try {
      return VirtualEconomy.wallet;
    } catch {
      return ctx.services.wallet ?? null;
    }
  };
  return {
    get coins() {
      return wallet()?.coins ?? fallback.coins;
    },
    /** PlayFabWallet.Adopt(balance) + VirtualEconomy.Notify: move the local wallet to the server's figure. */
    adopt(balance: number) {
      const w = wallet();
      if (!w) {
        fallback.coins = balance;
        return;
      }
      const delta = Math.round(balance - w.coins);
      if (delta > 0) VirtualEconomy.creditFreePlay(delta);
      else if (delta < 0) VirtualEconomy.tryDebitFreePlay(-delta);
      ctx.events.emit('wallet:changed');
    },
  };
}

/** StakeSelection.Resolve + SelectedBuyInChips from the C# PlayerPrefs keys. */
export function selectedStake(coins: number): { tier: StakeTier; buyIn: number } {
  const tier = StakeCatalog.resolve(PlayerPrefs.getInt('Poker.SelectedStake', 0), coins);
  const stored = Number(PlayerPrefs.getString('Poker.SelectedBuyIn', String(tier.startingStack)));
  const buyIn = clampBuyIn(Number.isFinite(stored) ? stored : tier.startingStack, tier, coins);
  return { tier, buyIn };
}

export interface BrowserIdentity extends ClientIdentity {
  readonly playerId: string;
  /** Overrides the hello's buy-in (the menu passes the slider value). */
  buyInOverride: number | null;
}

/**
 * `cloud`: tables on the game server, whose ledger verifies the Nomad API session token; the local server takes a
 * local ticket instead.
 */
export function browserIdentity(ctx: AppContext, wallet: WalletPort, cloud = false): BrowserIdentity {
  const tab = tabIdentity(ctx.params);
  const id: BrowserIdentity = {
    buyInOverride: null,
    get playerName() {
      if (tab) return tab.name;
      try {
        const n = PokerClientIdentity.playerName;
        if (n && n !== 'Player') return n;
      } catch {
        /* economy module absent */
      }
      return ctx.services.account.displayName || 'Player';
    },
    get token() {
      if (tab) return tab.token;
      try {
        return PokerClientIdentity.token;
      } catch {
        if (!PlayerPrefs.hasKey('Poker.ClientToken')) PlayerPrefs.setString('Poker.ClientToken', crypto.randomUUID().replace(/-/g, ''));
        return PlayerPrefs.getString('Poker.ClientToken');
      }
    },
    get playerId() {
      if (tab) return tab.playerId;
      let pf = '';
      try {
        pf = PokerClientIdentity.playFabId;
      } catch {
        /* ignore */
      }
      const raw = pf || ctx.services.account.playerId || `guest-${this.token.slice(0, 12)}`;
      return raw.replace(/[^A-Za-z0-9_\-.]/g, '').slice(0, 64) || 'guest';
    },
    get avatar() {
      return ctx.services.account.avatar ?? 0;
    },
    sessionTicket() {
      if (cloud) return ctx.services.nomadApi?.token ?? '';
      return `local:${this.playerId}:${Math.max(0, Math.floor(wallet.coins))}`;
    },
    selectedBuyInChips() {
      return this.buyInOverride ?? selectedStake(wallet.coins).buyIn;
    },
  };
  return id;
}
