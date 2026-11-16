/** Reject duplicate object keys before interpreting a bounded JSON document. */
export function parseUniqueJson(raw: string): unknown {
  const stack: { kind: 'object' | 'array'; keys: Set<string>; expectingKey: boolean }[] = [];
  let inString = false, escaped = false, start = -1, nodes = 0;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') {
        inString = false;
        if (start >= 0) {
          const key: unknown = JSON.parse(raw.slice(start, index + 1));
          const current = stack.at(-1);
          if (++nodes > 20_000 || typeof key !== 'string' || !current || current.kind !== 'object' || current.keys.has(key)) throw new Error();
          current.keys.add(key);
          start = -1;
          current.expectingKey = false;
        }
      }
    } else if (char === '"') {
      inString = true;
      const current = stack.at(-1);
      if (current?.kind === 'object' && current.expectingKey) start = index;
    } else if (char === '{' || char === '[') {
      if (++nodes > 20_000 || stack.length >= 32) throw new Error();
      stack.push({ kind: char === '{' ? 'object' : 'array', keys: new Set<string>(), expectingKey: char === '{' });
    } else if (char === '}' || char === ']') {
      stack.pop();
    } else if (char === ',') {
      const current = stack.at(-1);
      if (current?.kind === 'object') current.expectingKey = true;
    }
  }
  const parsed: unknown = JSON.parse(raw);
  return parsed;
}
