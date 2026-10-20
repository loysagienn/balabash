// Remote agents: catalog agents whose session runs in an external system
// (src/remote/engine.ts) — what every spawner should know about their
// threads: the mirror, the endless session, the three ways to close, the
// questions that need the user.
export const REMOTE_AGENTS_NOTE =
  'Some catalog agents are remote: their session runs in an external system (the agent’s name says which) ' +
  'and their thread mirrors that session — the agent’s replies, tool calls and questions appear in the ' +
  'thread, and every message sent into the thread reaches the session as the user’s word. A remote thread ' +
  'never ends on its own: the session is endless and the thread merely pauses when idle (state "paused"; a ' +
  'message wakes it). finish_thread asks the session for a closing summary and completes the thread with it; ' +
  'cancel_thread closes the thread without touching the session. Questions a remote agent raises (an ' +
  'approval of an action, a sign-in) need the user: relay them and never decide for the user — the user ' +
  'decides in the console or by the link. A remote thread you spawn is headless and talks only to you; one ' +
  'the secretary spawns talks to the user directly. Every step of a headless remote thread reaches you as a ' +
  'message, so that you see the work as it goes — most steps need no reply at all: ending your turn with ' +
  'empty text sends nothing, and that silence is the right answer to a step; relay to the user only what ' +
  'matters (a question of the agent, the end of a stage, a problem). A remote agent has no access to ' +
  'Balabash file storage: ' +
  'a file reaches it only as an attachment (the fileIds of the spawn or of send_to_thread — the files ' +
  'themselves land in its session), a fileId in the text is useless to it; a file it produced comes back ' +
  'only by your explicit remote_fetch_file with its path in the session.';
