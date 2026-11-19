// The check of arguments: one refusal by the input type for every capability
// and every action, whatever port the call came through. The refusal says
// what does not fit and carries the signature, so that the caller corrects
// the call without another `describe`.

import type { z } from 'zod';
import type { ActionDefinition } from './actions.ts';
import type { InputRule } from './definition.ts';
import { CapabilityError } from './errors.ts';
import type { Grant } from './grant.ts';
import { signatureText } from './signature.ts';

export type Issue = { path: string; message: string };

export function issuesOf(error: z.ZodError): Issue[] {
  return error.issues.map(issue => ({ path: issue.path.map(String).join('.'), message: issue.message }));
}

export function issuesText(issues: Issue[]): string {
  return issues.map(issue => `- ${issue.path ? `${issue.path}: ` : ''}${issue.message}`).join('\n');
}

export function invalidInput(name: string, issues: Issue[], signature: string): CapabilityError {
  return new CapabilityError(
    'invalid_input',
    `The input of \`${name}\` does not fit its signature:\n${issuesText(issues)}\nThe signature:\n${signature}`,
    { issues },
  );
}

const RULE_CHECKS: Record<string, { fits(count: number): boolean; words: string }> = {
  exactlyOne: { fits: count => count === 1, words: 'exactly one of' },
  atLeastOne: { fits: count => count >= 1, words: 'at least one of' },
  atMostOne: { fits: count => count <= 1, words: 'at most one of' },
};

// The conditions between optional fields, checked on the input as the caller
// wrote it: a field counts when it is there.
export function ruleIssues(rules: InputRule[], input: Record<string, unknown>): Issue[] {
  const issues: Issue[] = [];

  for (const rule of rules) {
    const [kind, fields] = Object.entries(rule)[0] as [string, string[]];
    const check = RULE_CHECKS[kind];
    const given = fields.filter(field => input[field] !== undefined);

    if (check && !check.fits(given.length)) {
      issues.push({
        path: '',
        message: `Pass ${check.words}: ${fields.join(', ')} (got ${given.length ? given.join(', ') : 'none'})`,
      });
    }
  }

  return issues;
}

// The input of an action, checked the same way as the input of a capability.
export function parseActionInput(grant: Grant, action: ActionDefinition, input: unknown): unknown {
  const parsed = action.input.safeParse(input ?? {});

  if (!parsed.success) {
    const declared = grant.catalog.actions.get(action.name);

    throw invalidInput(action.name, issuesOf(parsed.error), declared ? signatureText(declared) : action.name);
  }

  return parsed.data;
}
