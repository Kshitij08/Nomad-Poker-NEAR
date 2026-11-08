/** Port of Assets/Scripts/Tests/PlayFabWebResponseTests.cs. */
import { describe, expect, it } from 'vitest';
import { parsePlayFabWebResponse } from '../playFabWebResponse';

describe('PlayFabWebResponseTests', () => {
  it('ParseLogin_ReadsAuthenticationAndProfileFields', () => {
    const json = '{"code":200,"data":{"SessionTicket":"ticket","PlayFabId":"player","NewlyCreated":true,"EntityToken":{"EntityToken":"entity-token","Entity":{"Id":"entity-id","Type":"title_player_account"}},"InfoResultPayload":{"PlayerProfile":{"DisplayName":"Alice"}}}}';
    const r = parsePlayFabWebResponse(json);
    expect(r.isSuccess).toBe(true);
    expect(r.sessionTicket).toBe('ticket');
    expect(r.playFabId).toBe('player');
    expect(r.newlyCreated).toBe(true);
    expect(r.entityToken).toBe('entity-token');
    expect(r.entityId).toBe('entity-id');
    expect(r.entityType).toBe('title_player_account');
    expect(r.displayName).toBe('Alice');
  });

  it('ParseError_ReturnsPlayFabMessageWithoutCredentials', () => {
    const json = '{"code":400,"status":"BadRequest","error":"InvalidGoogleToken","errorCode":1026,"errorMessage":"Invalid credentials"}';
    const r = parsePlayFabWebResponse(json);
    expect(r.isSuccess).toBe(false);
    expect(r.errorCode).toBe('InvalidGoogleToken');
    expect(r.errorMessage).toBe('Invalid credentials');
  });

  it('empty / invalid', () => {
    expect(parsePlayFabWebResponse('  ').errorCode).toBe('EmptyResponse');
    expect(parsePlayFabWebResponse('{"nope":1}').errorCode).toBe('InvalidResponse');
  });
});
