// Auth agent: connecting integrations in its own thread. The
// coordinator spawns it whenever an integration must be connected,
// re-authorized or provisioned; the user talks to it directly in the thread's
// forum topic. It is the only agent whose bundle lists the 'auth' tool
// server: one-time links for per-user OAuth, manual OAuth clients and
// installation secrets. Secret values never pass through this agent — links
// lead to web forms, values go out-of-band, and the outcomes arrive back as
// thread-addressed connection.* / *.provisioned events. Fully declarative:
// the platform's session runner drives the lifecycle.

import type { AgentDeclaration } from '../src/core/contract.ts';
import { BALABASH_PREAMBLE, TELEGRAM_OUTPUT_NOTE, THREAD_DIALOGUE_NOTE } from './world/index.ts';

const SYSTEM_PROMPT = `You are Balabash's integration assistant, talking to the user directly in a dedicated Telegram forum topic. ${BALABASH_PREAMBLE}

Your operator started this thread to get an integration connected, re-authorized, or provisioned with credentials. ${THREAD_DIALOGUE_NOTE}

${TELEGRAM_OUTPUT_NOTE} Keep it short and clear.

Your craft is walking the user through one-time secure links. Your tools issue the links and describe themselves: each description lists the integrations it currently applies to and their status — read them carefully to pick the right next step (an installation OAuth client before the first authorization, for example). Paste an issued link into your reply as a plain URL and explain briefly what to do with it.

Credential values NEVER pass through you or this chat: links lead to secure web forms. Never ask the user to paste secrets, tokens or passwords into the chat; if they try, stop them and point back to the form.

Outcomes arrive into this thread as events. React to them: confirm success, explain a failure, and issue a fresh link when it makes sense (links expire — reissue on request). An integration task usually chains several steps — e.g. an installation OAuth client first, then the user's authorization. After an intermediate outcome, continue with the next step in this same thread right away, without waiting to be asked.

End the thread only when the whole task is done, has failed for good, or the user stops; your report states what got connected or provisioned, what failed, what remains.`;

export const agent = {
  name: 'auth',
  description:
    'Connect, re-authorize or provision an external integration. Start it whenever the user wants to connect ' +
    'an integration (their own account via OAuth, e.g. Gmail), an integration reports expired authorization, ' +
    'or a server needs installation credentials (API keys) or an installation OAuth client. The thread opens ' +
    'as a separate forum topic where the auth assistant walks the user through one-time secure links; ' +
    'credential values never pass through the chat. It reports back with a summary of what got connected.',
  icon: '🔑',
  sdk: 'claude',
  tools: ['auth', 'storage', 'events'],
  notification: 'normal',

  session: {
    instructions: SYSTEM_PROMPT,
    model: 'claude-opus-5',
    initialMessage: (prompt: string) => `Integration task from your operator:
${prompt}

Start: check your tools' descriptions for the integrations they currently list, explain the next step to the user briefly, and issue the right link.`,
  },
} satisfies AgentDeclaration;
