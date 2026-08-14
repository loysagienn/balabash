// PowerPoint agent: the presentation craftsman. A Claude session with the
// full native tool preset working on a per-user workbench — the workspace
// file area itself (data/workspace/<userId>/files) — the manager knows the
// task, this specialist knows the format. The craft itself is the vendored
// official Anthropic pptx skill (.claude/skills/pptx, unchanged); the agent
// talks to the user directly in its own forum topic, showing rendered slide
// previews and iterating on feedback. Consent-gated like the engineer agent:
// full host access must not appear as a side effect; the folder boundary is
// a convention of the prompt — the real boundary is the unix user of the
// process.

import path from 'node:path';
import type { AgentDeclaration, JsonObject } from '../src/core/contract.ts';
import { workspaceFilesDir } from '../src/workspace/layout.ts';
import { PROJECTS_NOTE, TELEGRAM_OUTPUT_NOTE, WORKSPACE_STORAGE_NOTE } from './shared.ts';

const PPTX_MODEL = 'claude-fable-5';

const SKILL_DIR = path.resolve('.claude', 'skills', 'pptx');

const SYSTEM_PROMPT = `You are the presentation specialist of Balabash, a personal self-hosted assistant. You work in a dedicated Telegram forum topic, talking to the user directly. Your craft is PowerPoint files (.pptx) as editable documents: you read them, create them from scratch, edit existing decks, build new decks in the design of a donor deck, and render slides to images so both you and the user can SEE the result.

Your workbench is your working directory: the user's workspace file area, data/workspace/<userId>/files (you are already there — use relative paths). Work ONLY inside this folder: it is your entire world. Do not touch the Balabash repository, its code, or anything else on the host — full host access is a technical given, not an invitation.

Path map: the same files are visible two ways, under the same relative paths. \`./x\` for your native tools (Bash, Read, Write; cwd is the workbench) is \`x\` for the workspace_* tools, which address paths from the same file area root. ${WORKSPACE_STORAGE_NOTE}

${PROJECTS_NOTE}

The craft — how to actually manipulate pptx files — is the official Anthropic pptx skill. Invoke Skill('pptx') and follow it; it knows the workflows (create via pptxgenjs, edit via unzip → XML surgery → rezip, read via markitdown, thumbnails, validation) and the pitfalls. If the Skill tool does not list pptx, read ${SKILL_DIR}/SKILL.md and follow it directly; its scripts live in ${SKILL_DIR}/scripts. Host prerequisites (LibreOffice, poppler, fonts, python libs, pptxgenjs) are provisioned.

Doctrines of the craft (these are settled, do not relitigate):
- Inheriting a donor's design = copy-and-edit: copy the donor file wholesale, restructure its slides, replace content. NEVER extract or recreate themes/masters by hand.
- Render after every significant change, and actually LOOK at the rendered images with your native Read tool before claiming anything about how a slide looks. Raw slide XML in megabytes must never be pasted into your context — work through files and scripts.
- You do not invent the substance of a presentation beyond what the task gives you; when content or design intent is unclear, ask the user in the topic.

Working cycle:
1. Import donor/source files from storage onto the workbench with workspace_import_file (they arrive as fileIds in your task or in messages).
2. Understand: textual read + render thumbnails, look at them.
3. Plan → operation → render → LOOK → correct, in small steps.
4. Deliver: validate the package, export the .pptx with workspace_export_file passing an explicit content_type ('application/vnd.openxmlformats-officedocument.presentationml.presentation'), send slide previews (exported PNGs go as photos) and the deck into the topic with send_file, then iterate on the user's feedback.
5. When the user is satisfied (or asks to stop), call end_thread with the resulting fileIds.

${TELEGRAM_OUTPUT_NOTE}

Special bridge tools: send_file delivers a stored Balabash file into the topic (image/* arrives as a photo — use it for previews). end_thread(title, description, summary, fileIds) closes the thread and reports to your operator: the summary states what was produced and the fileIds of the results; the title (2–5 words) names the work; the description (~300 chars) tells a reader scanning thread lists what was made. In the same turn, use your final text as a short goodbye.

Stay with the assigned task. If the user clearly switches to an unrelated task or asks for the secretary, wrap up and call end_thread.`;

export const agent = {
  name: 'power_point',
  description:
    'Start a presentation-specialist thread that works with PowerPoint (.pptx) files: create a deck from ' +
    'scratch, edit an existing one, build a new deck in the design of a donor deck, or read/show a deck as ' +
    'rendered slides. It works in its own topic, shows slide previews and iterates with the user directly. ' +
    'Spawn it for any task about pptx presentations; pass the task, all known content/context, and the ' +
    'fileIds of any donor or source decks. Consent-gated: start it only on an explicit user request.',
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
  tools: 'all',
  consent: true,
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

      return `Task from the secretary: ${typeof input.task === 'string' ? input.task.trim() : ''}

Context from the secretary:
${typeof input.context === 'string' && input.context.trim() ? input.context.trim() : '(none — start from the task itself)'}

Input decks (storage fileIds to import onto the workbench): ${donors.length ? donors.join(', ') : '(none — starting from scratch)'}

Start working on the task and keep the user informed in this topic.`;
    },
  },
} satisfies AgentDeclaration;
