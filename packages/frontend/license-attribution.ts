export function embeddedHostLicenseFromReadme(readme: string): string {
  const lines = readme.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === '## License');
  if (start < 0) throw new Error('The embedded-host package license section is missing.');
  const next = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  const text = lines.slice(start + 1, next < 0 ? undefined : next).join('\n').trim();
  if (text.length < 500 || !text.includes('Copyright (c) Microsoft Corporation.') ||
      !text.includes('Permission is hereby granted, free of charge') ||
      !/THE SOFTWARE IS PROVIDED (?:"AS IS"|\*AS IS\*)/.test(text)) {
    throw new Error('The embedded-host package license text could not be verified.');
  }
  return text;
}
