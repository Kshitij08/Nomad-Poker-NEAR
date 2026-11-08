/**
 * Port of Core/PlayFabWebResponse.cs: the credential-safe projection of a PlayFab REST response (what the WebGL
 * fetch bridge forwarded to C#). Here the browser parses JSON natively, so this reads the same fields off
 * `JSON.parse` instead of the C# hand scanner; the results match PlayFabWebResponseTests.
 */
export interface PlayFabWebResponse {
  readonly isSuccess: boolean;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly sessionTicket: string | null;
  readonly playFabId: string | null;
  readonly newlyCreated: boolean;
  readonly entityToken: string | null;
  readonly entityId: string | null;
  readonly entityType: string | null;
  readonly displayName: string | null;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const str = (o: Json | null, k: string): string | null => (o && typeof o[k] === 'string' ? (o[k] as string) : null);

function failure(errorCode: string, errorMessage: string): PlayFabWebResponse {
  return {
    isSuccess: false, errorCode, errorMessage, sessionTicket: null, playFabId: null, newlyCreated: false,
    entityToken: null, entityId: null, entityType: null, displayName: null,
  };
}

export function parsePlayFabWebResponse(json: string | null | undefined): PlayFabWebResponse {
  if (json == null || json.trim().length === 0) return failure('EmptyResponse', 'PlayFab returned an empty response.');
  let root: Json | null;
  try {
    root = obj(JSON.parse(json));
  } catch {
    root = null;
  }
  if (!root || typeof root.code !== 'number' || !Number.isInteger(root.code)) {
    return failure('InvalidResponse', 'PlayFab returned an invalid response.');
  }
  const data = obj(root.data);
  const entityToken = obj(data?.EntityToken);
  const entity = obj(entityToken?.Entity);
  const profile = obj(obj(data?.InfoResultPayload)?.PlayerProfile);
  return {
    isSuccess: root.code === 200,
    errorCode: str(root, 'error'),
    errorMessage: str(root, 'errorMessage'),
    sessionTicket: str(data, 'SessionTicket'),
    playFabId: str(data, 'PlayFabId'),
    newlyCreated: data?.NewlyCreated === true,
    entityToken: str(entityToken, 'EntityToken'),
    entityId: str(entity, 'Id'),
    entityType: str(entity, 'Type'),
    displayName: str(profile, 'DisplayName'),
  };
}
