import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../v2hud.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every `.v2hud-raise…` rule that sets a display value (other than none). */
function displayRules(): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim();
    if (/\.v2hud-raise(?![-\w])/.test(sel) && !/\[hidden\]/.test(sel) && /(^|;|\s)display\s*:\s*(?!none)/.test(m[2])) out.push(sel);
  }
  return out;
}

describe('v2hud.css', () => {
  it('lets [hidden] close the raise sheet in every layout (the phone .compact grid included)', () => {
    const hidden = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => /\.v2hud-raise\.compact\[hidden\]/.test(m[1]));
    expect(hidden, 'a .v2hud-raise.compact[hidden] rule').toBeTruthy();
    expect(hidden![2]).toMatch(/display\s*:\s*none\s*!important/);
    // Any display rule on the sheet must not be !important, or it would beat the [hidden] rule.
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (displayRules().includes(m[1].trim())) expect(m[2]).not.toMatch(/display\s*:[^;]*!important/);
    }
    expect(displayRules()).toContain('.v2hud-raise.compact');
  });

  it('has one button style: the plate, ringed in the game colours (no design-option switcher selectors)', () => {
    expect(css).not.toMatch(/data-ui-btn/);
    expect(css).toMatch(/\[data-v2b='fold'\][^{]*\{[^}]*--hue: var\(--tbl-fold\)/);
    expect(css).toMatch(/\[data-v2b='call'\][^{]*\{[^}]*--hue: var\(--tbl-call\)/);
    expect(css).toMatch(/\[data-v2b='raise'\][^{]*\{[^}]*--hue: var\(--tbl-raise\)/);
    expect(css).toMatch(/border: 4px solid var\(--hue\)/);
  });
});
