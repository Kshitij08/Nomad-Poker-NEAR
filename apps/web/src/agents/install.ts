import type { AppContext } from '../app/app';
import { RewardGrant, type VirtualWallet } from '../app/services';
import { AgentStrategyState } from '../core/agents';
import { HttpAgentBackend, LocalAgentBackend, LOCAL_FARM_KEY, type AgentBackend } from './agentBackend';
import { AgentDeployService, type AgentSummaryCloud } from './agentDeployService';
import { AgentsService, prefsStore } from './agentsService';
import { installReplayChrome } from './replaySession';
import type { AgentMoney } from './server/agentFarm';
import { registerNomadPartial } from '../menu/host';
import { agentsPartial } from './nomad/agentsPartial';
import { endpointParam } from '../app/flags';

declare module '../app/app' {
  interface Services {
    /** The Coins AFK Agent: deploy / stop / progress / history, the strategy, hand replays. */
    agents?: AgentsService;
    /**
     * The player's Agent strategy (AgentStrategyState): values, streets, applyAll, onChanged, tag. The menu's Market
     * dialogs (My Twin, marketplace, Coach) apply strategies through it.
     */
    agentStrategy?: AgentStrategyState;
  }
}

/** The economy wallet (src/economy/services.ts EconomyWallet): debits with a named sink and returns free-play stacks. */
type EconomyWalletLike = VirtualWallet & {
  trySpendCoins?(amount: number, source: string): boolean;
  creditFreePlay?(chips: number): void;
  refresh?(): Promise<void>;
};

/**
 * The local farm's hold on Coins (the backend's agentMoney.ts, played by this device): the bankroll leaves the wallet at
 * deploy (trySpendCoins 'agent_bankroll') and what is left comes back at the end (creditFreePlay), so the client settles
 * it as a server-settled deployment.
 */
function walletMoney(ctx: AppContext): AgentMoney | null {
  const wallet = () => ctx.services.wallet as EconomyWalletLike | undefined;
  if (!wallet()) return null; // no economy module: an unfunded demo farm
  const credit = (amount: number, source: string) => {
    const w = wallet();
    if (!w || amount <= 0) return;
    if (w.creditFreePlay) w.creditFreePlay(amount);
    else w.grant(RewardGrant.coins(amount, source));
  };
  return {
    fund(_id, _owner, bankroll) {
      const w = wallet();
      if (!w) return;
      const ok = w.trySpendCoins ? w.trySpendCoins(bankroll, 'agent_bankroll') : false;
      if (!ok) throw new Error('Not enough Coins to allocate that agent bankroll.');
      ctx.events.emit('wallet:changed');
    },
    refund(_id, _owner, bankroll) {
      credit(bankroll, 'agent_refund');
      ctx.events.emit('wallet:changed');
    },
    settle(_id, _owner, amount) {
      credit(amount, 'agent_cashout');
      ctx.events.emit('wallet:changed');
    },
  };
}

/** PlayFabAgentProgress (economy porter's): mirrors the last summary to PlayFab UserData when present. */
function summaryCloud(ctx: AppContext): AgentSummaryCloud | null {
  const p = (ctx.services as unknown as Record<string, unknown>).progress as Partial<AgentSummaryCloud> | undefined;
  return p && typeof p.loadAgentSummary === 'function' && typeof p.saveAgentSummary === 'function' ? (p as AgentSummaryCloud) : null;
}

/** Installs the agents module: the `agents` service and the 'agents' screen. */
export function install(ctx: AppContext): void {
  const strategy = new AgentStrategyState(prefsStore);
  let deploy: AgentDeployService | null = null;

  // The real backend only when explicitly asked for (?agentBackend=https://…); never by default (PORTING-RULES).
  const remote = endpointParam(ctx.params, 'agentBackend');
  const backend: AgentBackend = remote
    ? new HttpAgentBackend(remote, async () => null)
    : new LocalAgentBackend({
        money: walletMoney(ctx),
        load: () => prefsStore.getString(LOCAL_FARM_KEY, '') || null,
        save: (json) => prefsStore.setString(LOCAL_FARM_KEY, json),
        handSeconds: Number(ctx.params.get('agentHandSeconds')) || 12,
        onChanged: () => void deploy?.refreshProgress(),
        lease: { get: () => prefsStore.getString(LOCAL_FARM_KEY + '.lease', '') || null, set: (v) => prefsStore.setString(LOCAL_FARM_KEY + '.lease', v) },
        visible: () => typeof document !== 'undefined' && document.visibilityState === 'visible',
      });
  // A closing / reloading page hands the tables over at once (the next page adopts its Agent without waiting for the lease).
  if (typeof window !== 'undefined') window.addEventListener('pagehide', () => backend.dispose());
  // A hot-reloaded module must not leave its old farm ticking next to the new one.
  import.meta.hot?.dispose(() => {
    backend.dispose();
    deploy?.stopWatcher();
  });

  deploy = new AgentDeployService({
    backend,
    prefs: prefsStore,
    ownerId: () => ctx.services.account?.playerId ?? null,
    coins: () => ctx.services.wallet?.coins ?? Number.MAX_SAFE_INTEGER,
    // VirtualEconomy.CreditFreePlay (a pre-ledger deployment's stack) and PlayFabWallet.RefreshAsync.
    creditCoins: (amount) => {
      const w = ctx.services.wallet as EconomyWalletLike | undefined;
      if (w?.creditFreePlay) w.creditFreePlay(amount);
      else w?.grant(RewardGrant.coins(amount, 'free_cashout'));
      ctx.events.emit('wallet:changed');
    },
    refreshWallet: () => {
      void (ctx.services.wallet as EconomyWalletLike | undefined)?.refresh?.();
      ctx.events.emit('wallet:changed');
    },
    summaryCloud: () => summaryCloud(ctx),
    onChanged: () => ctx.events.emit('agents:changed'),
  });
  deploy.startWatcher();
  // PlayFabAgentProgress.PullAsync ends with AgentDeployService.TrySettleFromStore (the cloud summary may finish a deployment).
  const agentChanged = (ctx.services as unknown as { progress?: { agentChanged?: { on(fn: () => void): () => void } } }).progress?.agentChanged;
  agentChanged?.on(() => deploy?.trySettleFromStore());

  const agents = new AgentsService(ctx, deploy, strategy);
  ctx.services.agents = agents;
  ctx.services.agentStrategy = strategy;
  installReplayChrome();
  // NomadUiHost.Agents.cs + NomadUiHost.Strategy.cs on the menu's Nomad host (the Agents_* screens).
  registerNomadPartial(agentsPartial(agents));

  // ?agents=1 opens Agents_Overview once the menu is up (debug).
  if (ctx.params.get('agents') === '1') {
    const off = ctx.events.on<string | null>('router:changed', (id) => {
      if (id !== 'menu') return;
      off();
      setTimeout(() => ctx.services.nomad?.signedIn && ctx.services.nomad.show('Agents_Overview'), 0);
    });
  }
  (globalThis as Record<string, unknown>).__agents = agents;
}
