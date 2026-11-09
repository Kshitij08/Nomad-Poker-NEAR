#!/usr/bin/env node
// Makes a player an admin (or support), or removes one. Admins are added by an operator in D1, never through the API:
// this is that operator step, with an audit row ('grant' / 'revoke', admin_id 'operator').
//   node infra/add-admin.mjs <stage> <player> [admin|support]     # player: id (p_…), wallet address, or Friend ID
//   node infra/add-admin.mjs <stage> <player> --remove
//   node infra/add-admin.mjs <stage> --list
// The web admin page (/admin.html) shows a signed-in non-admin their player id and this command.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const STAGES = {
  staging: 'c9570cef-7f57-4845-b503-03da7893d36d',
  production: 'e630e086-697c-47c7-84c3-8ad467005c34',
};
const args = process.argv.slice(2);
const [stage, who] = args;
const db = STAGES[stage];
const remove = args.includes('--remove');
const role = args.find((a) => a === 'admin' || a === 'support') ?? 'admin';
if (!db || !who) {
  console.error('usage: node infra/add-admin.mjs <staging|production> <playerId | wallet | Friend ID> [admin|support] [--remove]\n       node infra/add-admin.mjs <stage> --list');
  process.exit(2);
}
const cfScript = fileURLToPath(new URL('../node_modules/cf/bin/cf', import.meta.url));
const query = (sql) => {
  const out = JSON.parse(execFileSync(process.execPath, [cfScript, 'd1', 'query', db, '--sql', sql], { encoding: 'utf8' }));
  return out.flatMap((r) => r.results ?? []);
};

if (who === '--list') {
  console.table(query('SELECT a.player_id, a.role, p.display_name, a.note, datetime(a.added_at / 1000, \'unixepoch\') AS added FROM admin_users a JOIN players p ON p.id = a.player_id ORDER BY a.added_at'));
  process.exit(0);
}

// Every value goes into SQL text (cf d1 query has no parameters), so only these shapes are accepted.
if (!/^[A-Za-z0-9_-]{4,64}$/.test(who)) {
  console.error('That is not a player id, wallet address or Friend ID.');
  process.exit(2);
}
const code = who.replace(/-/g, '').toUpperCase();
const found = query(
  `SELECT p.id, p.display_name, p.kind FROM players p WHERE p.id = '${who}' OR p.friend_code = '${code}'
   UNION SELECT p.id, p.display_name, p.kind FROM identities i JOIN players p ON p.id = i.player_id WHERE i.provider = 'wallet' AND i.subject = '${who}'`,
);
if (found.length !== 1) {
  console.error(found.length ? `Ambiguous: ${found.map((p) => p.id).join(', ')}` : `No player matches ${who} on ${stage}.`);
  process.exit(1);
}
const p = found[0];
if (p.kind === 'guest' && !remove) {
  console.error(`${p.display_name} (${p.id}) is a guest account. Admins need a signed-in identity (wallet, Google or email) so the account can be recovered.`);
  process.exit(1);
}
const now = Date.now();
if (remove) {
  query(`DELETE FROM admin_users WHERE player_id = '${p.id}'`);
  query(`INSERT INTO admin_audit (admin_id, action, target_id, details, created_at) VALUES ('operator', 'revoke', '${p.id}', '{}', ${now})`);
  console.log(`${p.display_name} (${p.id}) is no longer an admin on ${stage}.`);
} else {
  query(
    `INSERT INTO admin_users (player_id, role, added_at, note) VALUES ('${p.id}', '${role}', ${now}, 'infra/add-admin.mjs')
     ON CONFLICT (player_id) DO UPDATE SET role = excluded.role`,
  );
  query(`INSERT INTO admin_audit (admin_id, action, target_id, details, created_at) VALUES ('operator', 'grant', '${p.id}', '{"role":"${role}"}', ${now})`);
  console.log(`${p.display_name} (${p.id}) is now ${role === 'admin' ? 'an admin' : 'support'} on ${stage}. Reload /admin.html.`);
}
