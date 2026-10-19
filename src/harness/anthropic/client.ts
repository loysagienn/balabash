import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config/index.ts';

let client: Anthropic | null = null;

// One client for the process: the key is the only configuration (the
// Console organization linked to the Claude plan; its monthly credits pay),
// passed explicitly — the SDK must not read the environment (see
// config.anthropicApiKey).
export function getAnthropicClient(): Anthropic {
  client ??= new Anthropic({ apiKey: config.anthropicApiKey });

  return client;
}
