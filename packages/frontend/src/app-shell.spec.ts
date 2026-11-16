import { describe, expect, it } from 'vitest';
import appShell from '../index.html?raw';

describe('app shell', () => {
  it('does not request third-party font stylesheets', () => {
    expect(appShell).not.toMatch(/https?:\/\/fonts\.(?:googleapis|gstatic)\.com/i);
  });
});
