/** A row of `players` (migrations/0001_init.sql). */
export interface PlayerRow {
  id: string;
  display_name: string;
  kind: 'guest' | 'registered';
  created_at: number;
  last_seen_at: number;
}
