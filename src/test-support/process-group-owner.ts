// Child of tree/program.test.ts. Its cwd, database and workspace are the
// stand's. The test cuts this process off while its program and command run.
import { computeGrant, runProgram } from '../catalog/index.ts';
import { catalog } from '../tree/index.ts';
import { connectionsPort } from '../tree/services.ts';

const [workspaceId, threadId] = process.argv.slice(2);
const env = { connections: connectionsPort() };
const grant = await computeGrant(catalog(), { allows: vertex => vertex.name === 'workspace', actions: ['run_program', 'call'] }, {
  ...env, caller: { workspaceId, threadId, agentName: 'tester' },
});

// The shell exits; sleep keeps the output pipe open. The program stays
// busy in JS and cannot process the IPC disconnect from its dead parent.
await runProgram(grant, {
  code: `
    void call('workspace_run_command', { command: 'sleep 60 & echo "$$ $!" > crash.pids' });
    const until = Date.now() + 60000;
    while (Date.now() < until) {}
    return null;
  `,
}, env);
