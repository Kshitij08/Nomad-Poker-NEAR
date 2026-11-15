/**
 * The agents module on the menu's Nomad host (what is left of NomadUiHost.Agents.cs now the Redesign v2 Agents pages,
 * src/ui2/screens/agents.ts, draw the screens): the service's dialogs go through the host's message box, a hand watched
 * from Session History comes back to Session History, and editing the sliders away from a copied strategy stops copying.
 */
import type { AppContext } from '../../app/app';
import type { NomadHost } from '../../menu/host';
import { onStrategyEdited, type AgentStrategyLike } from '../../menu/market';
import { AgentStopReasons } from '@nomad/engine/agents';
import type { AgentsService } from '../agentsService';

/** Session History status label and the chip look it borrows (PaintAgentHistory). */
export function stopReasonLabel(reason: string | null): { label: string; look: string } {
  const label = reason === AgentStopReasons.Bust ? 'Bust'
    : reason === AgentStopReasons.OwnerStop ? 'Stopped'
    : reason === AgentStopReasons.StopLoss ? 'Stop loss'
    : reason === AgentStopReasons.ProfitTarget ? 'Target hit'
    : reason === AgentStopReasons.MaxHands ? 'Hand limit'
    : reason === AgentStopReasons.MaxRuntime ? 'Time limit'
    : reason === AgentStopReasons.Halted ? 'Server stopped'
    // The table was lost (a server restart or crash): the bankroll / last stack was paid back.
    : reason === 'server_lost' ? 'Refunded'
    : reason === 'banned' ? 'Removed' : 'Completed';
  const look = label === 'Stop loss' || label === 'Server stopped' || label === 'Refunded' || label === 'Removed' ? 'Stopped'
    : label === 'Target hit' || label === 'Hand limit' || label === 'Time limit' ? 'Completed' : label;
  return { label, look };
}

export function agentsPartial(svc: AgentsService) {
  return (host: NomadHost, ctx: AppContext): void => {
    // Dialogs (rename, deploy, stop, the replay's "couldn't load") go through the Nomad message box.
    svc.messageSink = (title, body, ok, onOk, cancel, onCancel, input) =>
      host.message(title, body, ok, onOk ? () => onOk() : undefined, cancel, onCancel, input?.placeholder ?? null, input ? (v) => onOk?.(v) : undefined, input?.value ?? null);

    // Back from a hand watched at the table: the Session History and that session's hands again.
    ctx.events.on<string | null>('router:changed', (id) => {
      if (id !== 'menu' || !svc.reopenHands) return;
      host.show('Agents_SessionHistory');
    });

    // Editing the sliders away from a copied strategy stops copying it.
    const strategy = (ctx.services as unknown as Record<string, unknown>).agentStrategy as AgentStrategyLike | undefined;
    strategy?.onChanged(() => onStrategyEdited(strategy));
  };
}
