// Hard validation of a dynamic agent module against the v2 contract (§7.1) —
// adaptation of v1 validate-agent for the AgentDeclaration shape: flat object,
// tools bundle, domain events '<name>.*', no acceptsEvents/exclusive/
// triggersMainModel (gone by construction, design doc §1).

import path from 'node:path';
import type { AgentDeclaration, AgentRun } from '../core/contract.ts';
import { RESERVED_DOMAINS } from '../core/envelope.ts';

const AGENT_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const NOTIFICATION_LEVELS = new Set(['silent', 'normal', 'urgent']);

// The coordinator implements the contract statically in src/ — a dynamic
// agent must not shadow it in the catalog.
const RESERVED_AGENT_NAMES = new Set(['coordinator']);

const ALLOWED_KEYS = new Set([
  'name',
  'description',
  'icon',
  'sdk',
  'parameters',
  'tools',
  'consentTools',
  'consent',
  'events',
  'notification',
  'resumable',
  'run',
]);

export function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function validateAgent(module: Record<string, unknown>, filename: string): AgentDeclaration {
  const exports = Object.keys(module);

  if (exports.length !== 1 || exports[0] !== 'agent') {
    throw new Error(`${filename} must export only "agent"`);
  }

  const candidate = module.agent;

  if (!isObject(candidate)) {
    throw new Error(`${filename} export "agent" must be an object`);
  }

  const unknownKeys = Object.keys(candidate).filter(key => !ALLOWED_KEYS.has(key));

  if (unknownKeys.length) {
    throw new Error(`${filename} agent has unknown keys: ${unknownKeys.join(', ')}`);
  }

  if (typeof candidate.name !== 'string' || !AGENT_NAME_PATTERN.test(candidate.name)) {
    throw new Error(`${filename} agent.name must match ${AGENT_NAME_PATTERN}`);
  }

  const expectedName = path.basename(filename, '.ts');

  if (candidate.name !== expectedName) {
    throw new Error(`${filename} agent.name must equal filename "${expectedName}"`);
  }

  // The agent name doubles as its domain-event prefix, so it must not collide
  // with the canonical vocabulary (§4.2).
  if (RESERVED_DOMAINS.has(candidate.name) || RESERVED_AGENT_NAMES.has(candidate.name)) {
    throw new Error(`${filename} agent.name "${candidate.name}" is reserved`);
  }

  if (typeof candidate.description !== 'string' || !candidate.description.trim()) {
    throw new Error(`${filename} agent.description must be a non-empty string`);
  }

  if (candidate.icon !== undefined && (typeof candidate.icon !== 'string' || !candidate.icon.trim())) {
    throw new Error(`${filename} agent.icon must be a non-empty string when present`);
  }

  if (candidate.sdk !== 'claude' && candidate.sdk !== 'codex') {
    throw new Error(`${filename} agent.sdk must be one of claude, codex`);
  }

  if (!isObject(candidate.parameters) || candidate.parameters.type !== 'object') {
    throw new Error(`${filename} agent.parameters must be a JSON Schema object with type "object"`);
  }

  const validTools =
    candidate.tools === 'all' ||
    (Array.isArray(candidate.tools) && candidate.tools.every(name => typeof name === 'string' && Boolean(name.trim())));

  if (!validTools) {
    throw new Error(`${filename} agent.tools must be 'all' or an array of tool-server names`);
  }

  if (candidate.consentTools !== undefined) {
    const validConsentTools =
      Array.isArray(candidate.consentTools) &&
      candidate.consentTools.every(name => typeof name === 'string' && Boolean(name.trim()));

    if (!validConsentTools) {
      throw new Error(`${filename} agent.consentTools must be an array of tool-server names when present`);
    }
  }

  if (candidate.consent !== undefined && typeof candidate.consent !== 'boolean') {
    throw new Error(`${filename} agent.consent must be a boolean when present`);
  }

  if (candidate.events !== undefined) {
    if (!Array.isArray(candidate.events)) {
      throw new Error(`${filename} agent.events must be an array when present`);
    }

    const eventTypePrefix = `${candidate.name}.`;
    const eventTypes = new Set<string>();

    for (const [index, event] of candidate.events.entries()) {
      if (!isObject(event)) {
        throw new Error(`${filename} agent.events[${index}] must be an object`);
      }

      const eventKeys = Object.keys(event).sort();
      const expectedEventKeys = ['description', 'payloadSchema', 'type'];

      if (
        eventKeys.length !== expectedEventKeys.length ||
        eventKeys.some((key, keyIndex) => key !== expectedEventKeys[keyIndex])
      ) {
        throw new Error(`${filename} agent.events[${index}] must contain only type, description and payloadSchema`);
      }

      if (typeof event.type !== 'string' || !EVENT_TYPE_PATTERN.test(event.type)) {
        throw new Error(`${filename} agent.events[${index}].type must match ${EVENT_TYPE_PATTERN}`);
      }

      if (!event.type.startsWith(eventTypePrefix)) {
        throw new Error(`${filename} agent.events[${index}].type must start with "${eventTypePrefix}"`);
      }

      if (eventTypes.has(event.type)) {
        throw new Error(`${filename} declares duplicate event type "${event.type}"`);
      }

      if (typeof event.description !== 'string' || !event.description.trim()) {
        throw new Error(`${filename} agent.events[${index}].description must be a non-empty string`);
      }

      if (!isObject(event.payloadSchema)) {
        throw new Error(`${filename} agent.events[${index}].payloadSchema must be an object`);
      }

      eventTypes.add(event.type);
    }
  }

  if (candidate.notification !== undefined && !NOTIFICATION_LEVELS.has(candidate.notification as string)) {
    throw new Error(`${filename} agent.notification must be one of silent, normal, urgent`);
  }

  if (candidate.resumable !== undefined && typeof candidate.resumable !== 'boolean') {
    throw new Error(`${filename} agent.resumable must be a boolean when present`);
  }

  if (typeof candidate.run !== 'function') {
    throw new Error(`${filename} agent.run must be a function`);
  }

  return candidate as unknown as AgentDeclaration;
}

export function validateAgentRun(run: unknown, agentName: string): AgentRun {
  if (!isObject(run)) {
    throw new Error(`Agent "${agentName}" run() must return an AgentRun object`);
  }

  if (typeof run.accept !== 'function') {
    throw new Error(`Agent "${agentName}" AgentRun.accept must be a function`);
  }

  if (!isObject(run.finished) || typeof run.finished.then !== 'function') {
    throw new Error(`Agent "${agentName}" AgentRun.finished must be a Promise`);
  }

  return run as unknown as AgentRun;
}
