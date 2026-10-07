import OpenAI from 'openai';
import { config } from '../../config/index.ts';
import { getLlmBackend } from './backend.ts';

let client: OpenAI | null = null;

// One client for both backends: the OpenAI SDK speaks to any Responses API
// server once pointed at its base URL (the key is whatever that server
// expects — the internal gateway ignores it).
export function getOpenaiClient(): OpenAI {
  const { baseUrl } = getLlmBackend();

  client ??= new OpenAI({ apiKey: config.openaiApiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });

  return client;
}
