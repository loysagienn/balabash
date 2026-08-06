import OpenAI from 'openai';
import { config } from '../../config/index.ts';

let client: OpenAI | null = null;

export function getOpenaiClient(): OpenAI {
  client ??= new OpenAI({ apiKey: config.openaiApiKey });

  return client;
}
