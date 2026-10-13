// The engines behind the agents, named for the interface: the row of the
// catalog and the rail of a thread say "Claude", the agent's details say
// what the engine is. The words of AgentView.sdk.

import type { AgentView } from '../../../api/contract.ts';

const LABELS: Record<AgentView['sdk'], string> = { claude: 'Claude', codex: 'Codex', openai: 'OpenAI', remote: 'Remote' };
const NAMES: Record<AgentView['sdk'], string> = { claude: 'Claude Agent SDK', codex: 'Codex SDK', openai: 'OpenAI Responses API', remote: 'Remote agent — a session in an external system' };

// "Claude" — the engine in a row.
export function engineLabel(sdk: AgentView['sdk']): string {
  return LABELS[sdk];
}

// "Claude Agent SDK" — the engine in the details.
export function engineName(sdk: AgentView['sdk']): string {
  return NAMES[sdk];
}
