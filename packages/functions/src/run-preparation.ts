import type { Agent, RunPreparation, RunSelection, Suite } from '@rayfin-app/shared';
import { SafeError, uuid } from './safety.js';

function parseStringObject(input: string): Record<string, string> {
  let position = 0;
  const whitespace = () => { while (/[ \t\r\n]/.test(input[position] ?? '') && position < input.length) position++; };
  const string = (): string => {
    whitespace();
    const start = position;
    if (input[position++] !== '"') throw new Error();
    while (position < input.length) {
      const char = input[position++];
      if (char === '\\') {
        if (position >= input.length) throw new Error();
        position++;
      } else if (char === '"') {
        const value: unknown = JSON.parse(input.slice(start, position));
        if (typeof value !== 'string') throw new Error();
        return value;
      }
    }
    throw new Error();
  };
  const result: Record<string, string> = Object.create(null);
  whitespace();
  if (input[position++] !== '{') throw new Error();
  whitespace();
  if (input[position] !== '}') {
    while (true) {
      const key = string();
      whitespace();
      if (input[position++] !== ':' || Object.hasOwn(result, key)) throw new Error();
      result[key] = string();
      whitespace();
      if (input[position] !== ',') break;
      position++;
    }
  }
  if (input[position++] !== '}') throw new Error();
  whitespace();
  if (position !== input.length) throw new Error();
  return result;
}

export function parseRunSelection(input: string): RunSelection {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > 4096) {
    throw new SafeError('INVALID_INPUT', 'Run selection must be valid JSON under 4 KB.');
  }
  let value: Record<string, string>;
  try { value = parseStringObject(input); }
  catch { throw new SafeError('INVALID_INPUT', 'Run selection JSON is invalid.'); }
  const allowed = ['workspaceId', 'agentId', 'suiteId', 'stage'];
  if (Object.keys(value).length !== allowed.length || Object.keys(value).some(key => !allowed.includes(key)) ||
      (value.stage !== 'production' && value.stage !== 'sandbox')) {
    throw new SafeError('INVALID_INPUT', 'Run selection requires only a workspace, agent, suite and supported stage.');
  }
  return { workspaceId: uuid(value.workspaceId), agentId: uuid(value.agentId), suiteId: uuid(value.suiteId), stage: value.stage };
}

/** This contract is not a run, an approval, or evidence that the agent is published. */
export function prepareRun(selection: RunSelection, agent: Agent, suite: Suite): RunPreparation {
  if (agent.id !== selection.agentId || agent.workspaceId !== selection.workspaceId || suite.id !== selection.suiteId) {
    throw new SafeError('INVALID_SCOPE', 'The resolved agent or suite does not match the selection.');
  }
  const questions = new Set(suite.cases.map(item => item.question));
  if (questions.size !== suite.cases.length) {
    throw new SafeError('AMBIGUOUS_SUITE', 'Duplicate questions cannot be mapped reliably to evaluation results. Revise the suite first.');
  }
  const strings = [agent.name, agent.workspaceName, suite.name,
    ...suite.cases.flatMap(item => [item.question, item.expectedAnswer, item.category])];
  if (strings.some(value => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))) {
    throw new SafeError('INVALID_INPUT', 'The agent or suite contains unsupported Unicode text.');
  }
  return {
    schemaVersion: 1,
    target: { ...agent, stage: selection.stage, publicationVerified: false },
    suite,
  };
}
