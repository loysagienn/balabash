// Image generator agent: a headless sub-agent on OpenAI Codex that makes
// raster images with Codex's built-in image generation tool (image_gen) —
// a tool the Claude backend does not have. Like the browser agent it works
// for OTHER agents: its operator is the parent thread (the secretary, a
// manager, the designer), never the user; the dialogue is thread.message
// both ways, the turn's final text is the reply.
//
// One handoff path: storage. Finished images reach the operator only as
// stored fileIds attached to a message (send_images — the one tool of its
// own: workspace_export_file reads only the workspace file area, and the
// images live outside it); reference images the operator hands over as
// fileIds come down through storage_get_file's download URL into a temporary
// directory, for image_gen to take by local path. The working
// directory is the user's workspace file area — for reading context the
// brief points to; the agent writes nothing there (the prompt says so):
// where an image is kept is the operator's decision.
//
// image_gen writes every result under $CODEX_HOME/generated_images/<codex
// thread>/ (the app's isolated home, harness/codex-sdk/codex-home) and names
// the path in its output — the model takes the file from there.
//
// Fully declarative: the platform's session runner drives the Codex session,
// the headless channel binding and the base verbs (end_thread, send_file);
// send_images is the declaration's environment.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentDeclaration,
  JsonObject,
  RunContext,
  SdkBridgeTool,
  SessionEnvironment,
} from '../src/core/contract.ts';
import { workspaceFilesDir } from '../src/workspace/layout.ts';
import { BLOCKED_PATH_NOTE } from './world/index.ts';

// What send_images accepts: raster formats by extension, and a size cap well
// above any generated image.
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_IMAGES_PER_MESSAGE = 20;

const INSTRUCTIONS = `You are Balabash's image generator: a sub-agent working for another agent — your OPERATOR (the secretary, a manager or the designer of the Balabash assistant). You make raster images with your built-in image generation tool, image_gen — new images and edits of existing ones — and hand the finished images to the operator through Balabash file storage. You never talk to a human; wherever the notes below speak of the user, for you that is your operator.

Protocol:
- The first message carries the brief; later messages bring corrections, more variants or new images. Do the current instruction, then reply.
- The final text of each of your turns IS your reply to the operator, in the language of its instructions. Make it a concise report: one line per image handed over — its fileId and what it shows (which variant, what changed) — plus any choice you made that the brief left open and anything you could not satisfy, and why. Tool calls, file paths and your prompt rewrites stay in this thread unless the operator asks for them.
- Before generating, settle with the operator anything the brief leaves open that changes the result substantially — what the image is for, its aspect ratio or size, the exact text on it, the style direction: ask in your reply and wait for the answer. Small details nobody would argue about you decide yourself and mention in the report.
- Finishing an instruction NEVER ends the session: reply and wait — the operator iterates with you. Call end_thread only when the operator explicitly tells you to finish; its summary lists the fileIds of the final images.

Making images:
- Images are made ONLY with the built-in image_gen tool. Never draw them with code (SVG, canvas, PIL), never call an image API or an image CLI script yourself, never substitute pictures from the web. If image_gen is unavailable or keeps failing, report that to the operator.
- Make exactly as many images or variants as asked; when the brief names no number, make one. One image_gen call per image or variant.
- References and edits: image_gen takes reference images by local path. A file in the workspace file area goes by its path. A file the operator gives as a fileId: storage_get_file returns a download URL — download it with curl into a temporary directory outside the workspace file area (mktemp -d) and pass that path.
- image_gen saves each result under $CODEX_HOME/generated_images/ and its output names the exact file. Look at every result before handing it over. When it plainly misses the brief (misspelled text, wrong subject, broken composition), regenerate it once on your own; if it still falls short, hand over the best attempt, say what is wrong and let the operator decide.
- Post-processing (crop, resize, format conversion) is fine with your native tools on the generated file; write derived files next to the original under $CODEX_HOME/generated_images/.
- Codex's bundled imagegen skill describes other setups: its output paths (output/imagegen/ in the working directory) and its CLI or API fallback do not apply to you — where it disagrees with this brief, this brief wins.

Handing images over:
- Finished images reach the operator ONLY through send_images: it uploads local image files into Balabash file storage, attaches them to a message to the operator and returns their fileIds. Give each file a descriptive name — the filename travels all the way to the person who sees the image. Send all images of a step in one call, then finish the turn with your report naming those fileIds.
- Never save images into the workspace file area, finished or not: where an image is kept is the operator's decision, and it receives every image as a fileId.

Working directory: it is the user's workspace file area — the workbench shared with the operator and other agents, where project notes, brand materials and source images live. It is there for context: read what the brief points to, or what plainly matters for the image (a project's notes, a logo, a style guide). Treat it as read-only — you write nothing there. The host beyond it is not yours to explore.

${BLOCKED_PATH_NOTE}`;

function imageContentType(filePath: string): string | null {
  return IMAGE_TYPES[path.extname(filePath).toLowerCase()] ?? null;
}

function createSendImagesTool(ctx: RunContext, cwd: string): SdkBridgeTool {
  return {
    name: 'send_images',
    description:
      'Hand finished images to your operator: uploads local image files (PNG, JPEG, WebP, GIF) into Balabash ' +
      'file storage and attaches them to one message to the operator. Returns the fileId of each image. The ' +
      'only way an image reaches the operator.',
    inputSchema: {
      type: 'object',
      properties: {
        images: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_IMAGES_PER_MESSAGE,
          items: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Local path of the image file: absolute, or relative to your working directory.',
              },
              filename: {
                type: ['string', 'null'],
                description:
                  'Descriptive filename the stored image gets, with its extension (e.g. "astro-volga-banner-blue.png"); null = the file\'s own name.',
              },
            },
            required: ['path', 'filename'],
            additionalProperties: false,
          },
        },
        caption: {
          type: ['string', 'null'],
          description: 'Optional short plain-text caption of the message.',
        },
      },
      required: ['images', 'caption'],
      additionalProperties: false,
    },
    handler: async (args: JsonObject) => {
      const images = Array.isArray(args.images) ? args.images : [];

      if (!images.length) {
        throw new Error('send_images requires at least one image');
      }

      if (images.length > MAX_IMAGES_PER_MESSAGE) {
        throw new Error(`send_images takes at most ${MAX_IMAGES_PER_MESSAGE} images per call`);
      }

      // Every file is checked before anything is stored: a bad entry refuses
      // the whole call, nothing half-sent.
      const prepared: { absPath: string; filename: string; contentType: string; sizeBytes: number }[] = [];

      for (const image of images) {
        const entry = image && typeof image === 'object' && !Array.isArray(image) ? (image as JsonObject) : {};
        const rawPath = typeof entry.path === 'string' ? entry.path.trim() : '';

        if (!rawPath) {
          throw new Error('send_images: every image needs a path');
        }

        const absPath = path.resolve(cwd, rawPath);
        const info = await stat(absPath).catch(() => null);

        if (!info?.isFile()) {
          throw new Error(`send_images: no file at ${absPath}`);
        }

        if (info.size > MAX_IMAGE_BYTES) {
          throw new Error(`send_images: ${absPath} is larger than ${MAX_IMAGE_BYTES} bytes`);
        }

        const contentType = imageContentType(absPath);

        if (!contentType) {
          throw new Error(`send_images: ${absPath} is not a PNG, JPEG, WebP or GIF file`);
        }

        const requested = typeof entry.filename === 'string' ? entry.filename.trim().replace(/[/\\]/g, '_') : '';
        const filename = !requested
          ? path.basename(absPath)
          : imageContentType(requested)
            ? requested
            : `${requested}${path.extname(absPath).toLowerCase()}`;

        prepared.push({ absPath, filename, contentType, sizeBytes: info.size });
      }

      const stored: { fileId: string; filename: string }[] = [];

      for (const image of prepared) {
        const ref = await ctx.files.ingest({
          body: await readFile(image.absPath),
          filename: image.filename,
          contentType: image.contentType,
          sizeBytes: image.sizeBytes,
        });

        stored.push({ fileId: ref.id, filename: image.filename });
      }

      const caption = typeof args.caption === 'string' && args.caption.trim() ? args.caption.trim() : null;

      await ctx.sendToParent(
        caption ?? `[images] ${stored.map(image => image.filename).join(', ')}`,
        stored.map(image => image.fileId),
      );

      return { sent: stored };
    },
  };
}

async function createEnvironment(ctx: RunContext, cwd: string): Promise<SessionEnvironment> {
  return { extraTools: [createSendImagesTool(ctx, cwd)] };
}

export const agent = {
  name: 'image_generator',
  description:
    'An image-generating sub-agent: it generates and edits raster images (illustrations, photo-like pictures, ' +
    "banners, icons, variants and corrections of existing images) with OpenAI's built-in image generation, " +
    'and hands every finished image back as a stored fileId attached to its reply. Pass the brief: what the ' +
    'image is for, content and style, size or aspect ratio, exact text on it, and reference images as fileIds ' +
    'or workspace paths. The thread is headless — the sub-agent talks only to you: send instructions with ' +
    'send_to_thread, its replies arrive as thread.message events. It never ends on its own: it delivers, ' +
    'reports and waits for corrections — tell it explicitly to finish, or cancel the thread.',
  icon: '🖼️',
  sdk: 'codex',
  headless: true,
  tools: ['storage'],
  notification: 'normal',

  session: {
    instructions: INSTRUCTIONS,
    model: 'gpt-6-astra',
    effort: 'high',
    preset: 'full',
    cwd: (workspaceId: string) => workspaceFilesDir(workspaceId),
    environment: (ctx: RunContext, cwd: string) => createEnvironment(ctx, cwd),
  },
} satisfies AgentDeclaration;
