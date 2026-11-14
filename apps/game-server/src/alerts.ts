import type { ReconcileReport } from '@nomad/db/reconcile';
import type { Env } from './env';

/**
 * Operator alerts by email (Cloudflare Email Service, binding ALERT_EMAIL, production only). The owner's inbox is a
 * secret (ALERT_TO) and a verified Email Routing destination, so these mails are free and outside the sending quota.
 * Without the binding or the address every call is a no-op (staging, dev, tests): the logs stay the record.
 */

export async function sendAlert(env: Env, subject: string, text: string): Promise<boolean> {
  if (!env.ALERT_EMAIL || !env.ALERT_TO || !env.ALERT_FROM) return false;
  try {
    await env.ALERT_EMAIL.send({ to: env.ALERT_TO, from: env.ALERT_FROM, subject: `[Nomad Poker ${env.STAGE}] ${subject}`, text });
    return true;
  } catch (e) {
    console.error('[alert] email failed', (e as { code?: string }).code ?? '', (e as Error).message);
    return false;
  }
}

/** The hour (UTC) whose reconciliation also mails an "all clear" summary, so silence never hides a broken alert. */
export const DAILY_SUMMARY_HOUR = 4;

/** The reconciliation mail: problems every hour they persist; otherwise one summary a day. Null: nothing to send. */
export function reconcileMail(r: ReconcileReport, hourUtc: number): { subject: string; text: string } | null {
  const bad = r.checks.filter((c) => !c.ok);
  const lines = r.checks.map((c) => `${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}: ${c.checked} checked${c.ok ? '' : ` (${c.note})`}`);
  if (bad.length) {
    const detail = bad.map((c) => `${c.name}:\n${JSON.stringify(c.problems, null, 2)}`).join('\n\n');
    return {
      subject: `Ledger check found ${bad.length} problem${bad.length > 1 ? 's' : ''}`,
      text:
        `The hourly ledger reconciliation found problems.\n\n${lines.join('\n')}\n\n${detail}\n\n` +
        'Next steps: open /admin.html (Reconcile) for the full report; infra/table-from-r2.mjs recomputes a table from its hand records. ' +
        'This mail repeats every hour while the problem lasts.\n',
    };
  }
  if (hourUtc !== DAILY_SUMMARY_HOUR) return null;
  return {
    subject: 'Daily check: all clear',
    text: `Today's ledger reconciliation found no problems.\n\n${lines.join('\n')}\n\nYou get this once a day so you know alerts are working.\n`,
  };
}

/** A table that gave up on a write (the GAVE UP log): mailed at most once an hour per table. */
export class TableAlerts {
  private lastSent = 0;
  constructor(
    private readonly env: Env,
    private readonly session: string,
  ) {}

  onLog(level: string, message: string, waitUntil: (p: Promise<unknown>) => void): void {
    if (level !== 'error' || !message.includes('GAVE UP')) return;
    const now = Date.now();
    if (now - this.lastSent < 3_600_000) return;
    this.lastSent = now;
    waitUntil(
      sendAlert(
        this.env,
        `Table ${this.session} gave up on a write`,
        `A table could not save to the database after every retry.\n\nTable: ${this.session}\nError: ${message}\n\n` +
          `Check the books: open /admin.html (Reconcile), or node infra/logs.mjs nomad-poker-near-game "GAVE UP".\n` +
          'Further errors from this table are not mailed for an hour.\n',
      ),
    );
  }
}
