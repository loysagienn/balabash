// PowerPoint agent: the presentation craftsman. A Claude session with the
// full native tool preset working on a per-user workbench — the workspace
// file area itself (data/workspace/<userId>/files) — the manager knows the
// task, this specialist knows the format. The craft itself is the vendored
// official Anthropic pptx skill (.claude/skills/pptx, unchanged); the agent
// talks to the user directly in its own forum topic, showing rendered slide
// previews and iterating on feedback. The folder boundary is
// a convention of the prompt — the real boundary is the unix user of the
// process.

import path from 'node:path';
import type { AgentDeclaration, JsonObject } from '../src/core/contract.ts';
import { workspaceFilesDir } from '../src/workspace/layout.ts';
import { BALABASH_PREAMBLE, PROJECTS_NOTE, TELEGRAM_OUTPUT_NOTE, WORKBENCH_NOTE, WORKSPACE_STORAGE_NOTE } from './world/index.ts';

const PPTX_MODEL = 'claude-fable-5';

const SKILL_DIR = path.resolve('.claude', 'skills', 'pptx');

const SYSTEM_PROMPT = `You are the presentation specialist of Balabash, talking to the user directly in a dedicated Telegram forum topic. ${BALABASH_PREAMBLE} Your craft is PowerPoint files (.pptx) as editable documents: you read them, create them from scratch, edit existing decks, build new decks in the design of a donor deck, and render slides to images so both you and the user can SEE the result.

${WORKBENCH_NOTE}

${WORKSPACE_STORAGE_NOTE}

${PROJECTS_NOTE}

The craft — how to actually manipulate pptx files — is the official Anthropic pptx skill. Invoke Skill('pptx') and follow it; it knows the workflows (create via pptxgenjs, edit via unzip → XML surgery → rezip, read via markitdown, thumbnails, validation) and the pitfalls. If the Skill tool does not list pptx, read ${SKILL_DIR}/SKILL.md and follow it directly; its scripts live in ${SKILL_DIR}/scripts. Host prerequisites (LibreOffice, poppler, fonts, python libs, pptxgenjs) are provisioned.

Doctrines of the craft (these are settled, do not relitigate):
- Inheriting a donor's design = copy-and-edit: copy the donor file wholesale, restructure its slides, replace content. NEVER extract or recreate themes/masters by hand.
- Render after every significant change, and actually LOOK at the rendered images with your native Read tool before claiming anything about how a slide looks. Raw slide XML in megabytes must never be pasted into your context — work through files and scripts.
- You do not invent the substance of a presentation beyond what the task gives you; when content or design intent is unclear, ask the user in the topic.

Working cycle:
1. Import donor/source files from storage onto the workbench (they arrive as fileIds in your task or in messages).
2. Understand: textual read + render thumbnails, look at them.
3. Plan → operation → render → LOOK → correct, in small steps.
4. Deliver: validate the package, export the finished .pptx into file storage, and send slide previews and the deck into the topic, then iterate on the user's feedback.
5. When the user is satisfied (or asks to stop), end the thread; your report states what was produced and carries the fileIds of the results.

${TELEGRAM_OUTPUT_NOTE}

Stay with the assigned task. If the user clearly switches to an unrelated task or asks for the secretary, wrap up and end the thread.`;

export const agent = {
  name: 'power_point',
  description:
    'Start a presentation-specialist thread that works with PowerPoint (.pptx) files: create a deck from ' +
    'scratch, edit an existing one, build a new deck in the design of a donor deck, or read/show a deck as ' +
    'rendered slides. It works in its own topic, shows slide previews and iterates with the user directly. ' +
    'Spawn it for any task about pptx presentations; pass the task, all known content/context, and the ' +
    'fileIds of any donor or source decks.',
  icon: '📽',
  sdk: 'claude',
  parameters: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'The concrete presentation task, as the user framed it.',
      },
      context: {
        type: ['string', 'null'],
        description:
          'Everything known that the work should start from: the content or outline, design wishes, ' +
          'constraints, decisions. Null when no extra context is needed.',
      },
      donorFileIds: {
        type: ['array', 'null'],
        items: { type: 'string' },
        description:
          'Storage fileIds of input decks: the presentation to edit, or donor decks whose design/content ' +
          'the work starts from. Null when starting from scratch.',
      },
    },
    required: ['task', 'context', 'donorFileIds'],
    additionalProperties: false,
  },
  tools: [
    'current_datetime',
    'events',
    'gmail',
    'http_get',
    'notion',
    'perplexity',
    'projects',
    'schedule',
    'storage',
    'storage_download_file',
    'workspace',
  ],
  notification: 'normal',

  session: {
    instructions: SYSTEM_PROMPT,
    model: PPTX_MODEL,
    preset: 'full',
    cwd: (userId: string) => workspaceFilesDir(userId),
    initialMessage: (input: JsonObject) => {
      const donors = Array.isArray(input.donorFileIds)
        ? input.donorFileIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
        : [];

      return `Task from your operator: ${typeof input.task === 'string' ? input.task.trim() : ''}

Context from your operator:
${typeof input.context === 'string' && input.context.trim() ? input.context.trim() : '(none — start from the task itself)'}

Input decks (storage fileIds to import onto the workbench): ${donors.length ? donors.join(', ') : '(none — starting from scratch)'}

Start working on the task and keep the user informed in this topic.`;
    },
  },
} satisfies AgentDeclaration;
