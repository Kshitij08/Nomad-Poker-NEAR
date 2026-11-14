import { describe, expect, it } from 'vitest';
import type { ReconcileReport } from '@nomad/db/reconcile';
import { DAILY_SUMMARY_HOUR, reconcileMail, sendAlert, TableAlerts } from '../alerts';
import type { Env } from '../env';

const report = (ok: boolean): ReconcileReport => ({
  ok,
  at: '2026-11-14T04:07:00Z',
  checks: [
    { name: 'balances', ok: true, checked: 9, problems: [], note: 'balance = sum of ledger' },
    { name: 'tables', ok, checked: 3, problems: ok ? [] : [{ table: 't1', off: 50 }], note: 'chips in = chips out' },
  ],
});

function envWith(sent: { to: string; from: string; subject: string; text?: string }[]): Env {
  return {
    STAGE: 'production',
    ALERT_TO: 'owner@example.com',
    ALERT_FROM: 'Nomad Poker alerts <alerts@nomadpoker.fun>',
    ALERT_EMAIL: { send: async (m: (typeof sent)[number]) => (sent.push(m), { messageId: 'm' }) } as unknown as SendEmail,
  } as Env;
}

describe('reconcileMail', () => {
  it('mails problems at any hour, with the failing check named', () => {
    const m = reconcileMail(report(false), 13)!;
    expect(m.subject).toBe('Ledger check found 1 problem');
    expect(m.text).toContain('FAIL  tables');
    expect(m.text).toContain('"off": 50');
  });

  it('sends the all-clear only at the daily summary hour', () => {
    expect(reconcileMail(report(true), DAILY_SUMMARY_HOUR + 1)).toBeNull();
    expect(reconcileMail(report(true), DAILY_SUMMARY_HOUR)!.subject).toBe('Daily check: all clear');
  });
});

describe('sendAlert', () => {
  it('is a no-op without the binding or the address', async () => {
    expect(await sendAlert({ STAGE: 'staging' } as Env, 's', 't')).toBe(false);
  });

  it('prefixes the stage and sends to the owner', async () => {
    const sent: { to: string; from: string; subject: string }[] = [];
    expect(await sendAlert(envWith(sent), 'Hello', 'body')).toBe(true);
    expect(sent).toEqual([expect.objectContaining({ to: 'owner@example.com', subject: '[Nomad Poker production] Hello' })]);
  });
});

describe('TableAlerts', () => {
  it('mails a GAVE UP error once an hour per table and ignores other logs', async () => {
    const sent: { to: string; from: string; subject: string }[] = [];
    const a = new TableAlerts(envWith(sent), 'poker-free-st50');
    const pending: Promise<unknown>[] = [];
    const wait = (p: Promise<unknown>) => void pending.push(p);
    a.onLog('info', 'hand 12 done', wait);
    a.onLog('error', 'something else', wait);
    a.onLog('error', '[D1Ledger] settle GAVE UP after 5 tries: busy', wait);
    a.onLog('error', '[D1Ledger] settle GAVE UP after 5 tries: busy', wait);
    await Promise.all(pending);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toContain('poker-free-st50');
  });
});
