import { describe, expect, it, vi } from 'vitest';
import { tmpToHtml } from '../ui/richText';
import { resolveOnce } from '../ui/walletPicker';
import { buyInRange } from '../ui/buyInPrompt';
import { codeBytes, ordinal, span } from '../ui/lobbyTourney';
import { agentLabel, sessionWhen } from '../ui/lobbyAgent';
import { u64 } from '../ui/lobby';

describe('TMP rich text → HTML', () => {
  it('renders the tags PerUi texts use', () => {
    expect(tmpToHtml('<b>Private tables</b>  <size=60%>MagicBlock TEE rollup · devnet</size>')).toBe(
      '<b>Private tables</b>  <span style="font-size:0.6em">MagicBlock TEE rollup · devnet</span>',
    );
    expect(tmpToHtml('<color=#e0c27e>Invite-only</color>   ·   Blinds')).toBe('<span style="color:#e0c27e">Invite-only</span>   ·   Blinds');
    expect(tmpToHtml('Game balance: <u>tap Deposit or Join to set up</u>')).toBe('Game balance: <u>tap Deposit or Join to set up</u>');
  });

  it('escapes everything else, and prints unknown tags as text like TMP', () => {
    expect(tmpToHtml('<script>alert(1)</script> & "q"')).toBe('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;');
    expect(tmpToHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
    expect(tmpToHtml('<color=red;background:url(x)>x</color>')).toBe('&lt;color=red;background:url(x)&gt;x&lt;/color&gt;');
    expect(tmpToHtml('<size=50%" onload="x>y')).toBe('&lt;size=50%&quot; onload=&quot;x&gt;y');
  });

  it('closes what is left open and ignores stray closers', () => {
    expect(tmpToHtml('<b>open <color=#5ed39b>green')).toBe('<b>open <span style="color:#5ed39b">green</span></b>');
    expect(tmpToHtml('a</b>b')).toBe('a&lt;/b&gt;b');
    expect(tmpToHtml('line<br>next')).toBe('line\nnext');
  });
});

describe('wallet picker', () => {
  it('answers once: a pick racing Exit, then unmount, only reports the first', () => {
    const fn = vi.fn();
    const r = resolveOnce<string>(fn);
    expect(r('Phantom')).toBe(true);
    expect(r(null)).toBe(false);
    expect(r('Solflare')).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('Phantom');
  });

  it('still counts as answered when the callback throws', () => {
    const r = resolveOnce<string>(() => {
      throw new Error('boom');
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(r(null)).toBe(true);
    expect(r('x')).toBe(false);
    err.mockRestore();
  });
});

describe('PrivateBuyInPrompt numbers', () => {
  it('500–1,000 capped by the Coin balance, starting at the most the player can put down', () => {
    expect(buyInRange(5000)).toEqual({ min: 500, max: 1000, canAfford: true, value: 1000 });
    expect(buyInRange(750)).toEqual({ min: 500, max: 750, canAfford: true, value: 750 });
    expect(buyInRange(300)).toEqual({ min: 500, max: 500, canAfford: false, value: 500 });
  });
});

describe('private-table panels helpers', () => {
  it('PerTourneyPanel.Span / Ordinal', () => {
    expect(span(40)).toBe('40 s');
    expect(span(125)).toBe('2 min');
    expect(span(7500)).toBe('2 h 5 min');
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st', '111th']);
  });

  it('PerTourneyHostPanel.CodeBytes: ASCII upper case, 16 bytes', () => {
    const b = codeBytes(' ab3x ');
    expect(b.length).toBe(16);
    expect(Array.from(b.slice(0, 5))).toEqual([65, 66, 51, 88, 0]);
  });

  it('PerAgentPanel labels and dates', () => {
    expect(agentLabel('running')).toBe('playing');
    expect(agentLabel('whatever')).toBe('stopped');
    expect(sessionWhen(new Date(2026, 9, 12, 9, 5))).toBe('12 Oct 09:05');
  });

  it('backend u64s as numbers or strings', () => {
    expect(u64('18446744073709551615')).toBe(18446744073709551615n);
    expect(u64(2_000_000)).toBe(2_000_000n);
    expect(u64(undefined)).toBe(0n);
    expect(u64('nope')).toBe(0n);
  });
});
