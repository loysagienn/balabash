// Hard validation of a dynamic agent module against the agent contract
// — adaptation of the legacy validate-agent for the AgentDeclaration shape:
// flat object, explicit tools list, domain events '<name>.*', no
// acceptsEvents/exclusive/triggersMainModel (gone by construction).

import path from 'node:path';
import type { AgentDeclaration, AgentRun } from '../core/contract.ts';
import { RESERVED_DOMAINS } from '../core/envelope.ts';

const AGENT_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const NOTIFICATION_LEVELS = new Set(['silent', 'normal', 'urgent']);

// The coordinator implements the contract statically in src/ — a dynamic
// agent must not shadow it in the catalog. 'secretary' is what prompts call
// the coordinator ('coordinator' stays the internal identifier in code, the
// event log and thread rows), so both names are off-limits.
const RESERVED_AGENT_NAMES = new Set(['coordinator', 'secretary']);

const ALLOWED_KEYS = new Set([
  'name',
  'description',
  'icon',
  'sdk',
  'tools',
  'agents',
  'events',
  'headless',
  'notification',
  'resumable',
  'session',
  'run',
]);

const SESSION_KEYS = new Set(['instructions', 'initialMessage', 'model', 'effort', 'preset', 'cwd']);
const SESSION_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const SESSION_PRESETS = new Set(['bridge-only', 'full']);

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
  // with the canonical vocabulary.
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

  const validTools =
    Array.isArray(candidate.tools) && candidate.tools.every(name => typeof name === 'string' && Boolean(name.trim()));

  if (!validTools) {
    throw new Error(`${filename} agent.tools must be an array of tool-server names`);
  }

  if (candidate.agents !== undefined) {
    const validAgents =
      Array.isArray(candidate.agents) &&
      candidate.agents.every(name => typeof name === 'string' && AGENT_NAME_PATTERN.test(name)) &&
      new Set(candidate.agents).size === candidate.agents.length;

    if (!validAgents) {
      throw new Error(`${filename} agent.agents must be an array of unique agent names when present`);
    }
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

  if (candidate.headless !== undefined && typeof candidate.headless !== 'boolean') {
    throw new Error(`${filename} agent.headless must be a boolean when present`);
  }

  if (candidate.notification !== undefined && !NOTIFICATION_LEVELS.has(candidate.notification as string)) {
    throw new Error(`${filename} agent.notification must be one of silent, normal, urgent`);
  }

  if (candidate.resumable !== undefined && typeof candidate.resumable !== 'boolean') {
    throw new Error(`${filename} agent.resumable must be a boolean when present`);
  }

  // Exactly one of the declarative session spec and the imperative run().
  const hasSession = candidate.session !== undefined;
  const hasRun = candidate.run !== undefined;

  if (hasSession === hasRun) {
    throw new Error(`${filename} agent must declare exactly one of "session" and "run"`);
  }

  if (hasRun && typeof candidate.run !== 'function') {
    throw new Error(`${filename} agent.run must be a function`);
  }

  if (hasSession) {
    const session = candidate.session;

    if (!isObject(session)) {
      throw new Error(`${filename} agent.session must be an object`);
    }

    const unknownSessionKeys = Object.keys(session).filter(key => !SESSION_KEYS.has(key));

    if (unknownSessionKeys.length) {
      throw new Error(`${filename} agent.session has unknown keys: ${unknownSessionKeys.join(', ')}`);
    }

    if (typeof session.instructions !== 'string' || !session.instructions.trim()) {
      throw new Error(`${filename} agent.session.instructions must be a non-empty string`);
    }

    if (session.initialMessage !== undefined && typeof session.initialMessage !== 'function') {
      throw new Error(`${filename} agent.session.initialMessage must be a function when present`);
    }

    if (session.model !== undefined && (typeof session.model !== 'string' || !session.model.trim())) {
      throw new Error(`${filename} agent.session.model must be a non-empty string when present`);
    }

    if (session.effort !== undefined && !SESSION_EFFORTS.has(session.effort as string)) {
      throw new Error(`${filename} agent.session.effort must be one of low, medium, high, xhigh, max`);
    }

    if (session.preset !== undefined && !SESSION_PRESETS.has(session.preset as string)) {
      throw new Error(`${filename} agent.session.preset must be one of bridge-only, full`);
    }

    const validCwd =
      session.cwd === undefined ||
      typeof session.cwd === 'function' ||
      (typeof session.cwd === 'string' && Boolean(session.cwd.trim()));

    if (!validCwd) {
      throw new Error(`${filename} agent.session.cwd must be a non-empty string or a (userId) => string function`);
    }
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
