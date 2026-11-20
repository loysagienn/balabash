// Runs in Claude Code's mod host. Execution and authorization stay in MCP.
const prefix = 'mcp__balabash__';

export function register(on) {
  const contexts = new Map();
  function guides(agentId) {
    if (!contexts.has(agentId)) contexts.set(agentId, new Map());
    return contexts.get(agentId);
  }

  function companion(leaf, agentId) {
    const seen = guides(agentId);
    const guide = leaf.guide.join('\n');
    const lines = ['Opened: ' + leaf.name];
    if (leaf.parent && guide && seen.get(leaf.parent) !== guide) lines.push(guide);
    seen.set(leaf.parent, guide);
    lines.push('Returns: ' + leaf.returns, ...leaf.rules, ...leaf.types);
    if (leaf.accounts.length) lines.push('Accounts: ' + JSON.stringify(leaf.accounts));
    return lines.join('\n');
  }

  on('prompt.attachment', async (_api, event, next) => {
    const response = await next(event);
    if (event.type !== 'deferred_tools_delta' || typeof response?.text !== 'string') return response;
    const lines = response.text.split('\n');
    const kept = lines.filter(line => !line.startsWith(prefix));
    if (kept.length === lines.length) return response;
    return { ...response, text: kept.some(line => /^[\w-]+$/.test(line)) ? kept.join('\n') : null };
  });

  on('tool.call', { tool: prefix + 'describe' }, async (_api, event, next) => {
    const response = await next(event);
    if (next.origin && next.origin.plugin !== 'engine') return response;
    const opened = parse(response?.text);
    if (opened?.kind === 'node') guides(event.agentId).set(opened.name, opened.guide.join('\n'));
    if (opened?.kind !== 'capability') return response;
    return { result: [{ type: 'tool_reference', tool_name: prefix + opened.name }], context: [companion(opened, event.agentId)] };
  });

  on('tool.call', { tool: 'ToolSearch' }, async (api, event, next) => {
    const response = await next(event);
    const context = [...(response.context ?? [])];
    for (const name of response.result?.matches ?? []) {
      if (!name.startsWith(prefix) || name === prefix + 'describe' || name === prefix + 'run_program') continue;
      const answer = await api.mcp.call('balabash', 'describe', { name: name.slice(prefix.length) });
      const opened = parse(answer.content?.find(block => block.type === 'text')?.text);
      if (opened?.kind === 'capability') context.push(companion(opened, event.agentId));
    }
    return context.length ? { ...response, context } : response;
  });

  on('session.compact', async (_api, event, next) => {
    contexts.clear();
    return next(event);
  });
}

function parse(text) {
  try { return JSON.parse(text); } catch { return null; }
}
