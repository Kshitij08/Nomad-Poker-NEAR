/**
 * Agent hand replays as the dedicated server reports them (ReplayJson: a JSON string, since Unity's JsonUtility
 * cannot carry an arbitrary object). Stored as JSONB on agent_hands.replay_json.
 *
 * A replay that is too large or not a JSON object is DROPPED, not rejected: the server's hand reporter treats any
 * 4xx as permanent and discards the whole hand, so refusing a bad replay would also lose the hand's result, which
 * the session's totals are built from. The hand is stored without a replay and the viewer says so.
 */
export const REPLAY_MAX_BYTES = 32 * 1024;

export type ReplayParse =
  | { replay: Record<string, unknown>; dropped?: undefined }
  | { replay: null; dropped?: "too_large" | "invalid" };

export function parseReplay(value: unknown): ReplayParse {
  if (value === undefined || value === null) return { replay: null };
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return { replay: null };
    if (Buffer.byteLength(text, "utf8") > REPLAY_MAX_BYTES) return { replay: null, dropped: "too_large" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { replay: null, dropped: "invalid" };
    }
    return isPlainObject(parsed) ? { replay: parsed } : { replay: null, dropped: "invalid" };
  }
  if (!isPlainObject(value)) return { replay: null, dropped: "invalid" };
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return { replay: null, dropped: "invalid" };
  }
  if (Buffer.byteLength(text, "utf8") > REPLAY_MAX_BYTES) return { replay: null, dropped: "too_large" };
  return { replay: value };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
