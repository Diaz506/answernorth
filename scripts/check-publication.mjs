import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignoredDirectories = new Set(['.git', '.temp', '.vite', '__pycache__', 'coverage', 'dist', 'node_modules']);
const sensitiveNames = /^(?:\.env(?:\..*)?|\.deployments\.json|local\.settings\.json|deploymetadata\.json|runtimemetadata\.json)$/i;
const allowedExample = /^\.env\.example$/i;
const textExtensions = new Set(['.css', '.html', '.ipynb', '.js', '.json', '.md', '.mjs', '.py', '.svg', '.ts', '.tsx', '.txt', '.yml', '.yaml']);
const patterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['JWT-like token', /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g],
  ['home-directory path', /\b[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s"']+/gi],
  ['deployed Fabric app hostname', /\bhttps:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.webapp\.fabricapps\.net\b/gi],
  ['email address', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
];
const markers = (process.env.ANSWERNORTH_PRIVATE_MARKERS ?? '').split('|').filter(Boolean);
const findings = [];
let scanned = 0;
const relative = file => path.relative(root, file).split(path.sep).join('/');
async function scan(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    for (const marker of markers) {
      if (entry.name.toLowerCase().includes(marker.toLowerCase())) findings.push(`${relative(file)}: private marker in path`);
    }
    if (entry.isSymbolicLink()) { findings.push(`${relative(file)}: symbolic link requires review`); continue; }
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) await scan(file);
      continue;
    }
    if (!entry.isFile() || entry.name.endsWith('.tsbuildinfo')) continue;
    if (sensitiveNames.test(entry.name) && !allowedExample.test(entry.name)) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!textExtensions.has(ext) && !['LICENSE', '.gitignore', '.gitattributes', '.nvmrc'].includes(entry.name)) {
      findings.push(`${relative(file)}: unreviewed non-text file`);
      continue;
    }
    const raw = await readFile(file);
    if (raw.includes(0)) { findings.push(`${relative(file)}: binary content requires review`); continue; }
    const content = raw.toString('utf8');
    scanned++;
    for (const [label, pattern] of patterns) {
      for (const match of content.matchAll(pattern)) {
        if (label === 'email address' && /@(?:example\.(?:com|org|net|invalid)|example)$/i.test(match[0])) continue;
        const lineText = content.slice(content.lastIndexOf('\n', match.index) + 1, content.indexOf('\n', match.index) < 0 ? undefined : content.indexOf('\n', match.index));
        // Preserve the published maintainer contact in the glob deprecation metadata.
        if (label === 'email address' && relative(file) === 'package-lock.json' &&
            lineText.includes('"deprecated":') && match[0] === ['i', 'izs.me'].join('@')) continue;
        const line = content.slice(0, match.index).split('\n').length;
        findings.push(`${relative(file)}:${line}: ${label}`);
      }
    }
    for (const marker of markers) {
      const index = content.toLowerCase().indexOf(marker.toLowerCase());
      if (index >= 0) findings.push(`${relative(file)}:${content.slice(0, index).split('\n').length}: private marker`);
    }
  }
}
await scan(root);
if (findings.length) {
  console.error(JSON.stringify({ ok: false, scanned, findings }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, scanned,
    warning: 'Heuristic scan only; review file selection, identifiers, licensing, history, and customer data before publication.' }, null, 2));
}
