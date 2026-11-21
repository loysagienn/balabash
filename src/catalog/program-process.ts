// The process of one program run: what the runner (program.ts) starts with
// `node -e`. It is source text, not a module: a process of its own needs no
// bundle entry and no path that differs between the bundle and the tests.
//
// Two pieces:
//
// - the prelude runs inside the context the program lives in. That context
//   is a bare JavaScript realm: the language's own globals and nothing of
//   the host — no require, no process, no timers, no fetch, no modules. The
//   prelude makes `call`, `describe` and `console` there, so every value the
//   program touches is of its own realm;
// - the host part runs in the process's main realm: it compiles the code as
//   the body of an async function, talks to the app over the IPC channel and
//   reports how the program ended.
//
// The context is a border of meaning, not of security (the scheme does not
// consider isolation): a program has only the catalog because that is what
// a program is.
//
// The channel:
//   app → process  { type: 'start', code }
//                  { type: 'settle', id, payload }   payload: JSON text of
//                      { ok: true, value } | { ok: false, error }
//   process → app  { type: 'request', id, kind: 'call' | 'describe', name, input }
//                      input: JSON text, or null when none was passed
//                      sent when its turn has come: no more than
//                      CALLS_AT_A_TIME of them are with the app at once
//                  { type: 'done', report }          report: JSON text of
//                      { outcome: 'value', value }
//                      { outcome: 'not_json', path, what }
//                      { outcome: 'call_error', error }
//                      { outcome: 'exception', text, line }
//                      { outcome: 'syntax', text, line }
// Console output goes to the standard output, written straight to its
// descriptor: such a write blocks until the app has read, so a program that
// floods its console waits for the reader instead of filling memory, and
// what a program said before it was killed has reached the app.

// The name the program's code is compiled under: stack frames carry it, and
// the line of an exception is read from them.
export const PROGRAM_FILE = 'program.js';

// How many calls of one run are with the app at a time; the rest wait their
// turn in the order they were made. A program may start any number at once
// (a Promise.all over a list): each call in flight holds its own resources
// in the app, and the ones that wait lie with their inputs in the memory of
// the program's own process, which has its own limit.
export const CALLS_AT_A_TIME = 8;

const PRELUDE = String.raw`
(function (hostRequest, hostPrint, callsAtATime) {
  'use strict';

  const AsyncFunction = (async function () {}).constructor;
  const pending = new Map();
  // The calls whose turn has not come, and how many are with the app.
  const waiting = [];
  let sent = 0;
  let lastId = 0;
  let idleWaiters = [];

  function pump() {
    while (sent < callsAtATime && waiting.length) {
      sent += 1;
      hostRequest.apply(null, waiting.shift());
    }
  }

  class CapabilityError extends Error {
    constructor(value) {
      super(value.message);
      this.name = 'CapabilityError';
      this.kind = value.kind;
      if (value.details !== undefined) this.details = value.details;
    }
  }

  function request(kind, name, input) {
    return new Promise(function (resolve, reject) {
      let text = null;
      try {
        // What JSON cannot say at all (a function) goes as null: the app
        // refuses it by the input type.
        if (input !== undefined) text = JSON.stringify(input) || 'null';
      } catch (error) {
        reject(new CapabilityError({
          kind: 'invalid_input',
          message: 'The input of ' + kind + '("' + name + '") is not JSON: ' + errorText(error),
        }));
        return;
      }
      lastId += 1;
      pending.set(lastId, { resolve: resolve, reject: reject });
      waiting.push([lastId, kind, name, text]);
      pump();
    });
  }

  function refused(message) {
    return Promise.reject(new CapabilityError({ kind: 'invalid_input', message: message }));
  }

  function call(name, input) {
    if (typeof name !== 'string') {
      return refused('call(name, input) takes the full name of a capability as a string.');
    }
    return request('call', name, input);
  }

  function describe(name) {
    if (name !== undefined && typeof name !== 'string') {
      return refused('describe(name) takes the full name of a vertex as a string, or nothing for the root.');
    }
    return request('describe', name === undefined ? null : name, undefined);
  }

  function settle(id, payload) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    sent -= 1;
    pump();
    const outcome = JSON.parse(payload);
    if (outcome.ok) entry.resolve(outcome.value);
    else entry.reject(new CapabilityError(outcome.error));
    if (pending.size === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resume of waiters) resume();
    }
  }

  function errorText(error) {
    let text;
    try {
      text = error !== null && typeof error === 'object' && typeof error.message === 'string'
        ? String(error.name || 'Error') + ': ' + error.message
        : String(error);
    } catch (unprintable) {
      text = 'an exception that cannot be printed';
    }
    return text.length > 2000 ? text.slice(0, 2000) + '…' : text;
  }

  // The line of the program an exception came from: the nearest frame of
  // its stack that lies in the program's code.
  function lineOf(error) {
    try {
      const frames = String(error.stack).split('\n').filter(function (line) { return /^\s+at /.test(line); });
      for (const frame of frames) {
        const match = /program\.js:(\d+)/.exec(frame);
        if (match) return Number(match[1]);
      }
    } catch (unreadable) {}
    return null;
  }

  function show(value) {
    if (typeof value === 'string') return value;
    try {
      if (value !== null && typeof value === 'object' && typeof value.message === 'string' && typeof value.stack === 'string') {
        return errorText(value);
      }
      const json = JSON.stringify(value);
      return json === undefined ? String(value) : json;
    } catch (unprintable) {
      try { return String(value); } catch (still) { return '[unprintable]'; }
    }
  }

  function print() {
    hostPrint(Array.prototype.map.call(arguments, show).join(' ') + '\n');
  }

  const console = { log: print, info: print, warn: print, error: print, debug: print };
  globalThis.console = console;

  // Why a value is not JSON, or null when it is: what JSON would drop or
  // change in silence (undefined, NaN, a Date, a Map, a function) is not
  // JSON here — the value a program returns is the value its reader gets.
  function notJson(value, path, ancestors) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? null : { path: path, what: String(value) };
    if (typeof value !== 'object') return { path: path, what: value === undefined ? 'undefined' : 'a ' + typeof value };
    if (ancestors.indexOf(value) !== -1) return { path: path, what: 'an object that contains itself' };
    const isArray = Array.isArray(value);
    const proto = Object.getPrototypeOf(value);
    if (!isArray && proto !== Object.prototype && proto !== null) {
      const name = proto.constructor && typeof proto.constructor.name === 'string' ? proto.constructor.name : '';
      return { path: path, what: name ? 'a ' + name + ' object' : 'an object that is not plain data' };
    }
    ancestors.push(value);
    if (isArray) {
      for (let index = 0; index < value.length; index += 1) {
        const found = notJson(value[index], path + '[' + index + ']', ancestors);
        if (found) return found;
      }
    } else {
      for (const key of Object.keys(value)) {
        const found = notJson(value[key], path === '' ? key : path + '.' + key, ancestors);
        if (found) return found;
      }
    }
    ancestors.pop();
    return null;
  }

  function failure(error) {
    if (error instanceof CapabilityError) {
      try {
        return JSON.stringify({
          outcome: 'call_error',
          error: { kind: error.kind, message: error.message, details: error.details },
        });
      } catch (changed) {}
    }
    return JSON.stringify({ outcome: 'exception', text: errorText(error), line: lineOf(error) });
  }

  return {
    // Whether the code is the body of one function: nothing in it ends the
    // function it is put into.
    isBody: function (code) {
      try { new AsyncFunction(code); return true; } catch (error) { return false; }
    },
    run: function (program) {
      return Promise.resolve()
        .then(function () { return program(call, describe, console); })
        .then(
          function (value) { return { returned: true, value: value }; },
          function (error) { return { returned: false, error: error }; }
        );
    },
    settle: settle,
    pending: function () { return pending.size; },
    whenIdle: function (resume) { idleWaiters.push(resume); },
    // How the program ended, as the JSON text of the report. A rejection
    // nobody caught (a call started and left without a catch) fails the
    // program like an exception of its own.
    report: function (result, hasUncaught, uncaught) {
      if (!result.returned) return failure(result.error);
      if (hasUncaught) return failure(uncaught);
      let problem;
      try {
        problem = notJson(result.value, '', []);
      } catch (error) {
        problem = { path: '', what: 'a value that cannot be read (' + errorText(error) + ')' };
      }
      if (problem) return JSON.stringify({ outcome: 'not_json', path: problem.path, what: problem.what });
      return JSON.stringify({ outcome: 'value', value: result.value });
    },
  };
})
`;

export const PROGRAM_PROCESS = `
'use strict';
const fs = require('node:fs');
const vm = require('node:vm');

const PROGRAM_FILE = ${JSON.stringify(PROGRAM_FILE)};
const context = vm.createContext({});
const send = message => { if (process.connected) process.send(message); };
const prelude = vm.runInContext(${JSON.stringify(PRELUDE)}, context, { filename: 'program-prelude.js' })(
  (id, kind, name, input) => send({ type: 'request', id, kind, name, input }),
  print,
  ${CALLS_AT_A_TIME},
);

// The descriptor itself, never process.stdout: the stream would switch the
// pipe to writes that do not block and keep the text in memory.
function print(text) {
  const bytes = Buffer.from(text, 'utf8');
  for (let written = 0; written < bytes.length; ) {
    written += fs.writeSync(1, bytes, written);
  }
}

// Rejections nobody has caught so far. A call left without a catch must not
// take the process down: how the program ended is decided when it ends.
const uncaught = new Map();
process.on('unhandledRejection', (reason, promise) => { uncaught.set(promise, reason); });
process.on('rejectionHandled', promise => { uncaught.delete(promise); });

const turn = () => new Promise(resolve => setImmediate(resolve));

function done(report) {
  if (!process.connected) process.exit(1);
  process.send({ type: 'done', report }, () => process.exit(0));
}

function syntaxReport(error) {
  // A SyntaxError of a compiled script carries its place in the first line
  // of the stack: "<file>:<line>".
  const head = String(error && error.stack).split('\\n')[0];
  const at = head.startsWith(PROGRAM_FILE + ':') ? Number(head.slice(PROGRAM_FILE.length + 1)) : NaN;
  const text = error && typeof error.message === 'string' ? String(error.name || 'Error') + ': ' + error.message : String(error);
  return JSON.stringify({ outcome: 'syntax', text, line: Number.isInteger(at) ? at : null });
}

async function start(code) {
  let program;
  try {
    // The header shares no line with the code: line 1 is the first line of
    // the program.
    const script = new vm.Script('(async function (call, describe, console) {\\n' + code + '\\n})', {
      filename: PROGRAM_FILE,
      lineOffset: -1,
    });
    if (!prelude.isBody(code)) {
      done(JSON.stringify({ outcome: 'syntax', text: 'SyntaxError: the code closes the function it is the body of', line: null }));
      return;
    }
    program = script.runInContext(context);
  } catch (error) {
    done(syntaxReport(error));
    return;
  }

  const result = await prelude.run(program);

  if (result.returned) {
    // A call the program started and did not wait for is waited for: a run
    // that ended well has no call still on its way.
    for (;;) {
      await turn();
      if (prelude.pending() === 0) break;
      await new Promise(resolve => prelude.whenIdle(resolve));
    }
  }

  const reasons = [...uncaught.values()];
  done(prelude.report(result, reasons.length > 0, reasons[0]));
}

process.on('message', message => {
  if (message.type === 'settle') prelude.settle(message.id, message.payload);
  else if (message.type === 'start') {
    // A failure of this process itself, not of the program: the app reads it
    // from the exit code and the standard error.
    start(message.code).catch(error => {
      process.stderr.write(String((error && error.stack) || error));
      process.exit(70);
    });
  }
});
// Without the app there is nobody to call and nobody to answer to.
process.on('disconnect', () => process.exit(1));
`;
