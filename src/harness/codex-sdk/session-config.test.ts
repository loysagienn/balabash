import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { codexSessionConfig } from './session-config.ts';

describe('codexSessionConfig', () => {
  const config = codexSessionConfig('Read balabash/AGENTS.md first.', 'http://127.0.0.1:43123/mcp');

  it('asks the API for reasoning summaries explicitly — "auto" resolves to the model default, "none" for gpt-6-astra', () => {
    // Without this key the reasoning items come back with an empty summary and
    // the SDK stream has no `reasoning` item, so the feed has no Thought rows.
    assert.equal(config.model_reasoning_summary, 'detailed');
  });

  it('puts the brief in the developer-message position and the bridge as the one MCP server', () => {
    assert.equal(config.developer_instructions, 'Read balabash/AGENTS.md first.');
    assert.deepEqual(config.mcp_servers, {
      balabash: { url: 'http://127.0.0.1:43123/mcp', required: true, default_tools_approval_mode: 'approve' },
    });
  });

  it('keeps the host layer out: no project docs, no apps, plugins, memories or goals', () => {
    assert.equal(config.project_doc_max_bytes, 0);
    assert.deepEqual(config.features, { apps: false, plugins: false, memories: false, goals: false, image_generation: false });
  });

  it('drops the bundled skills whole when the session does not draw', () => {
    assert.deepEqual(config.skills, { bundled: { enabled: false } });
  });

  it('with image generation keeps image_gen and the imagegen skill, turning the other bundled skills off by name', () => {
    const drawing = codexSessionConfig('brief', 'http://127.0.0.1:1/mcp', { imageGeneration: true });

    assert.deepEqual(drawing.features, { apps: false, plugins: false, memories: false, goals: false, image_generation: true });
    assert.deepEqual(drawing.skills, {
      config: [
        { name: 'openai-docs', enabled: false },
        { name: 'skill-installer', enabled: false },
        { name: 'skill-creator', enabled: false },
      ],
    });
  });
});
