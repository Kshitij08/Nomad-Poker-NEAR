/** A row of `players` (migrations/0001_init.sql). */
export interface PlayerRow {
  id: string;
  display_name: string;
  kind: 'guest' | 'registered';
  created_at: number;
  last_seen_at: number;
  /** Public Friend ID, 16 hex characters (migrations/0004_social.sql). */
  friend_code?: string | null;
  /** AvatarCatalog value, 0 = none. */
  avatar?: number;
}
