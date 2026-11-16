import { describe, expect, it } from 'vitest';
import { embeddedHostLicenseFromReadme } from '../license-attribution';

const license = [
  'Copyright (c) Microsoft Corporation.',
  'MIT License',
  'Permission is hereby granted, free of charge,',
  'Additional license text. '.repeat(30),
  'THE SOFTWARE IS PROVIDED "AS IS"',
].join('\n\n');

describe('embedded-host attribution', () => {
  it('extracts the complete license section without following sections', () => {
    expect(embeddedHostLicenseFromReadme(`# Package\n\n## License\n\n${license}\n\n## Other\nNot the license`))
      .toBe(license);
    const markdown = license.replace('"AS IS"', '*AS IS*');
    expect(embeddedHostLicenseFromReadme(`## License\r\n\r\n${markdown}`)).toBe(markdown);
  });

  it('rejects missing and incomplete license sections', () => {
    for (const value of ['# Package', '## License\nMIT', `## License\n${license.replace('"AS IS"', '"OTHER"')}`]) {
      expect(() => embeddedHostLicenseFromReadme(value)).toThrow();
    }
  });
});
