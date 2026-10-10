import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SecretRequestField, SecretRequestView } from '../../../api/contract.ts';
import type { ApiFailure } from '../../lib/api/index.ts';
import {
  REQUIRED_ERROR,
  SAVE_IDLE,
  afterProvision,
  missingRequired,
  provisionValues,
  reduceSave,
  requestState,
  requestStateOfFailure,
  secretRequestKey,
  secretsFailure,
  secretsTitle,
  submitLabel,
} from './Secrets.logic.ts';
import type { SaveState, SecretRequestState, Submission } from './Secrets.logic.ts';

const OAUTH_FIELDS: SecretRequestField[] = [
  { key: 'client_id', label: 'Client ID', description: 'OAuth client identifier issued by the provider', required: true, secret: false },
  { key: 'client_secret', label: 'Client secret', description: 'Leave empty for a public client', required: false, secret: true },
];

// The server's shape of an external-secrets request: every field required and secret.
const EXTERNAL_FIELDS: SecretRequestField[] = [
  { key: 'API_TOKEN', label: 'API_TOKEN', description: 'Value for ${secret:API_TOKEN} in github.json', required: true, secret: true },
  { key: 'API_HOST', label: 'API_HOST', description: 'Value for ${secret:API_HOST} in github.json', required: true, secret: true },
];

const OAUTH: SecretRequestView = { id: 'a', kind: 'oauth-client', server: 'notion', fields: OAUTH_FIELDS };
const EXTERNAL: SecretRequestView = { id: 'b', kind: 'external-secrets', server: 'github', fields: EXTERNAL_FIELDS };

const NOT_FOUND: ApiFailure = { status: 404, code: 'not_found', message: 'No such secret request — it may already be fulfilled' };
const UNAUTHORIZED: ApiFailure = { status: 401, code: 'unauthorized', message: 'Sign in' };
const REFUSED: ApiFailure = { status: 400, code: 'provisioning_failed', message: 'Client ID is required' };
const NETWORK: ApiFailure = { status: 0, code: 'network', message: 'Failed to fetch' };

describe('secret entry logic', () => {
  it('names the card by the kind of request', () => {
    assert.equal(secretsTitle({ kind: 'oauth-client', server: 'notion' }), 'OAuth client for notion');
    assert.equal(secretsTitle({ kind: 'external-secrets', server: 'github' }), 'Secrets for github');
  });

  it('finds the required fields still empty, whitespace included, for both kinds', () => {
    assert.deepEqual(missingRequired(OAUTH_FIELDS, {}), { client_id: REQUIRED_ERROR });
    assert.deepEqual(missingRequired(OAUTH_FIELDS, { client_id: '  \n' }), { client_id: REQUIRED_ERROR });
    assert.deepEqual(missingRequired(OAUTH_FIELDS, { client_id: 'abc' }), {});
    // An optional field may stay empty.
    assert.deepEqual(missingRequired(OAUTH_FIELDS, { client_id: 'abc', client_secret: '' }), {});
    // External secrets: every field is required; a space is not a value (the server refuses it too).
    assert.deepEqual(missingRequired(EXTERNAL_FIELDS, { API_TOKEN: 'tok' }), { API_HOST: REQUIRED_ERROR });
    assert.deepEqual(missingRequired(EXTERNAL_FIELDS, { API_TOKEN: ' ', API_HOST: 'h' }), { API_TOKEN: REQUIRED_ERROR });
    assert.deepEqual(missingRequired(EXTERNAL_FIELDS, { API_TOKEN: ' tok ', API_HOST: 'h' }), {});
  });

  it('sends every field of the request as typed, and nothing else', () => {
    // An external secret is stored byte for byte by the server: the edges stay.
    assert.deepEqual(provisionValues(EXTERNAL_FIELDS, { API_TOKEN: ' tok\t', API_HOST: 'h', extra: 'x' }), { API_TOKEN: ' tok\t', API_HOST: 'h' });
    // The OAuth client is trimmed by the server itself: the form does not pre-empt it.
    assert.deepEqual(provisionValues(OAUTH_FIELDS, { client_id: ' abc ', extra: 'x' }), { client_id: ' abc ', client_secret: '' });
    assert.deepEqual(provisionValues(OAUTH_FIELDS, { client_id: 'abc', client_secret: ' s3cret ' }), { client_id: 'abc', client_secret: ' s3cret ' });
    // A field never touched goes as empty — the server's optional branch.
    assert.deepEqual(provisionValues(OAUTH_FIELDS, { client_id: 'abc' }), { client_id: 'abc', client_secret: '' });
  });

  it('reads a failed call', () => {
    assert.deepEqual(secretsFailure(NOT_FOUND), { kind: 'expired' });
    assert.deepEqual(secretsFailure(UNAUTHORIZED), { kind: 'session' });
    assert.deepEqual(secretsFailure(REFUSED), { kind: 'failed', message: 'Client ID is required' });
    assert.deepEqual(secretsFailure(NETWORK), { kind: 'failed', message: 'Failed to fetch' });
  });

  it('names what the button waits for', () => {
    assert.equal(submitLabel(false), 'Save');
    assert.equal(submitLabel(true), 'Saving');
  });
});

describe('what the screen knows about one request id', () => {
  it('keys the knowledge by the id alone', () => {
    assert.deepEqual(secretRequestKey('a'), ['secret-request', 'a']);
    assert.notDeepEqual(secretRequestKey('a'), secretRequestKey('b'));
  });

  it('reads the answer of the GET: the form, or the row already gone', () => {
    assert.deepEqual(requestState({ request: OAUTH }), { kind: 'form', request: OAUTH });
    assert.deepEqual(requestStateOfFailure(NOT_FOUND), { kind: 'expired' });
    // Anything else is an error of the query (Retry), or the sign-in card's.
    assert.equal(requestStateOfFailure(UNAUTHORIZED), null);
    assert.equal(requestStateOfFailure(NETWORK), null);
    assert.equal(requestStateOfFailure({ status: 500, code: 'internal', message: 'boom' }), null);
  });

  describe('after the POST settles', () => {
    const form: SecretRequestState = { kind: 'form', request: EXTERNAL };

    it('success ends the row: saved, named after the form the values came from', () => {
      assert.deepEqual(afterProvision(form, null), { kind: 'saved', server: 'github' });
    });

    it('success of a call whose id the cache no longer knows (the session ended meanwhile) is still saved', () => {
      assert.deepEqual(afterProvision(undefined, null), { kind: 'saved', server: null });
    });

    it('a 404 ends the row: expired, from the form or from nothing', () => {
      assert.deepEqual(afterProvision(form, { kind: 'expired' }), { kind: 'expired' });
      assert.deepEqual(afterProvision(undefined, { kind: 'expired' }), { kind: 'expired' });
    });

    it('a refusal the operator can fix and a lost session leave the cache as it is', () => {
      assert.equal(afterProvision(form, { kind: 'failed', message: 'Client ID is required' }), undefined);
      assert.equal(afterProvision(form, { kind: 'session' }), undefined);
      assert.equal(afterProvision(undefined, { kind: 'failed', message: 'Failed to fetch' }), undefined);
      assert.equal(afterProvision(undefined, { kind: 'session' }), undefined);
    });

    it('a final outcome stays final: a late answer of another call never reopens or overturns it', () => {
      const saved: SecretRequestState = { kind: 'saved', server: 'github' };
      const expired: SecretRequestState = { kind: 'expired' };

      assert.equal(afterProvision(saved, null), undefined);
      assert.equal(afterProvision(saved, { kind: 'expired' }), undefined);
      assert.equal(afterProvision(saved, { kind: 'failed', message: 'x' }), undefined);
      assert.equal(afterProvision(expired, { kind: 'expired' }), undefined);
      assert.equal(afterProvision(expired, { kind: 'failed', message: 'x' }), undefined);
      // The one way out of "expired" would be a success of the same row — the server never answers both.
      assert.deepEqual(afterProvision(expired, null), { kind: 'saved', server: null });
    });

    it('never carries a value: the outcome is the kind and the server name only', () => {
      for (const outcome of [afterProvision(form, null), afterProvision(form, { kind: 'expired' })]) {
        assert.ok(outcome);
        assert.deepEqual(Object.keys(outcome).sort(), outcome.kind === 'saved' ? ['kind', 'server'] : ['kind']);
      }
    });
  });
});

describe('one submit of the form', () => {
  const a: Submission = { id: 'a' };

  it('starts idle, without a value anywhere', () => {
    assert.deepEqual(SAVE_IDLE, { submission: null, failure: null });
  });

  it('holds the submission in flight and forgets an earlier refusal', () => {
    const refused: SaveState = { submission: null, failure: 'Client ID is required' };

    assert.deepEqual(reduceSave(refused, { type: 'submit', submission: a }), { submission: a, failure: null });
  });

  it('is one call at a time: a second submit in flight is not a call', () => {
    const inFlight = reduceSave(SAVE_IDLE, { type: 'submit', submission: a });
    const again = reduceSave(inFlight, { type: 'submit', submission: { id: 'a' } });

    assert.equal(again, inFlight);
    assert.equal(again.submission, a);
  });

  it('applies the answer of the submission in flight: success and a 404 leave the form to the cache, a refusal stays', () => {
    const inFlight = reduceSave(SAVE_IDLE, { type: 'submit', submission: a });

    assert.deepEqual(reduceSave(inFlight, { type: 'settled', submission: a, outcome: null }), SAVE_IDLE);
    assert.deepEqual(reduceSave(inFlight, { type: 'settled', submission: a, outcome: { kind: 'expired' } }), SAVE_IDLE);
    assert.deepEqual(reduceSave(inFlight, { type: 'settled', submission: a, outcome: { kind: 'session' } }), SAVE_IDLE);
    assert.deepEqual(reduceSave(inFlight, { type: 'settled', submission: a, outcome: { kind: 'failed', message: 'Client ID is required' } }), {
      submission: null,
      failure: 'Client ID is required',
    });
  });

  it('ignores an answer that is not of the submission in flight: late, of another id, of another instance', () => {
    const inFlight = reduceSave(SAVE_IDLE, { type: 'submit', submission: a });
    const other: Submission = { id: 'a' };
    const b: Submission = { id: 'b' };

    // The same id, another call (an earlier instance of this id answering late).
    assert.equal(reduceSave(inFlight, { type: 'settled', submission: other, outcome: null }), inFlight);
    // Another id altogether.
    assert.equal(reduceSave(inFlight, { type: 'settled', submission: b, outcome: { kind: 'expired' } }), inFlight);
    // Nothing in flight: a late answer finds no submission to settle.
    assert.equal(reduceSave(SAVE_IDLE, { type: 'settled', submission: a, outcome: { kind: 'failed', message: 'x' } }), SAVE_IDLE);
    // After its own settle, a second answer of the same submission is late too.
    const settled = reduceSave(inFlight, { type: 'settled', submission: a, outcome: null });

    assert.equal(reduceSave(settled, { type: 'settled', submission: a, outcome: { kind: 'failed', message: 'x' } }), settled);
  });
});

// The lifecycle of the screen as the component drives it: a scripted run of
// the pure rules over a cache keyed by id and one save state per instance.
// Instances are keyed by id (App), so a change of id is a fresh SAVE_IDLE
// and fresh values; the cache outlives instances until the session ends.
describe('the lifecycle of the screen, scripted', () => {
  type Cache = Map<string, SecretRequestState>;

  const write = (cache: Cache, id: string, outcome: Parameters<typeof afterProvision>[1]) => {
    const next = afterProvision(cache.get(id), outcome);

    if (next !== undefined) {
      cache.set(id, next);
    }
  };

  it('a change of id while A is in flight: B is untouched by A’s answer, and A’s outcome waits under A', () => {
    const cache: Cache = new Map([
      ['a', requestState({ request: OAUTH })],
      ['b', requestState({ request: { ...OAUTH, id: 'b', server: 'github' } })],
    ]);
    const instanceA = { id: 'a', save: reduceSave(SAVE_IDLE, { type: 'submit', submission: { id: 'a' } }) };
    const submissionA = instanceA.save.submission;

    assert.ok(submissionA);

    // The route changes to B: a new instance, idle, with nothing of A's values or call.
    const instanceB = { id: 'b', save: SAVE_IDLE };

    assert.equal(instanceB.save.submission, null);
    assert.equal(cache.get('b')?.kind, 'form');

    // A's POST settles late, under the id it was sent to.
    write(cache, submissionA.id, null);
    instanceB.save = reduceSave(instanceB.save, { type: 'settled', submission: submissionA, outcome: null });

    assert.deepEqual(cache.get('b'), requestState({ request: { ...OAUTH, id: 'b', server: 'github' } }));
    assert.deepEqual(instanceB.save, SAVE_IDLE);
    assert.deepEqual(cache.get('a'), { kind: 'saved', server: 'notion' });
  });

  it('success, then away and back: the card is the outcome, there is no form to post again', () => {
    const cache: Cache = new Map([['a', requestState({ request: EXTERNAL })]]);
    const submission: Submission = { id: 'a' };
    let save = reduceSave(SAVE_IDLE, { type: 'submit', submission });

    write(cache, submission.id, null);
    save = reduceSave(save, { type: 'settled', submission, outcome: null });

    assert.deepEqual(cache.get('a'), { kind: 'saved', server: 'github' });
    assert.deepEqual(save, SAVE_IDLE);

    // Away and back: a fresh instance reads the cache — the saved card, not the form.
    assert.equal(cache.get('a')?.kind, 'saved');
  });

  it('a POST 404, then away and back: expired, from the cache, with no GET', () => {
    const cache: Cache = new Map([['a', requestState({ request: OAUTH })]]);
    const submission: Submission = { id: 'a' };

    write(cache, submission.id, { kind: 'expired' });
    assert.deepEqual(cache.get('a'), { kind: 'expired' });
    assert.deepEqual(reduceSave(reduceSave(SAVE_IDLE, { type: 'submit', submission }), { type: 'settled', submission, outcome: { kind: 'expired' } }), SAVE_IDLE);
  });

  it('a refusal keeps the form (the values with it) and the cache as it was', () => {
    const cache: Cache = new Map([['a', requestState({ request: OAUTH })]]);
    const submission: Submission = { id: 'a' };
    let save = reduceSave(SAVE_IDLE, { type: 'submit', submission });

    write(cache, submission.id, { kind: 'failed', message: 'Client ID is required' });
    save = reduceSave(save, { type: 'settled', submission, outcome: { kind: 'failed', message: 'Client ID is required' } });

    assert.equal(cache.get('a')?.kind, 'form');
    assert.deepEqual(save, { submission: null, failure: 'Client ID is required' });
  });

  it('the session ends while A is in flight: the cache is gone, A’s late success is remembered under A for the next session', () => {
    const cache: Cache = new Map([['a', requestState({ request: EXTERNAL })]]);
    const submission: Submission = { id: 'a' };

    reduceSave(SAVE_IDLE, { type: 'submit', submission });
    // SESSION_LOST: the store resets, the query client clears (lib/query/session.ts), the instance unmounts.
    cache.clear();

    write(cache, submission.id, null);
    assert.deepEqual(cache.get('a'), { kind: 'saved', server: null });

    // A late 401 of the same kind of call writes nothing: the sign-in card is the answer.
    cache.clear();
    write(cache, submission.id, { kind: 'session' });
    assert.equal(cache.get('a'), undefined);
  });
});
