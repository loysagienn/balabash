// Where a topic thread's messages come from: the operator opens it with the
// task, the user speaks after that, and the workspace may be multi-voice.
export const THREAD_DIALOGUE_NOTE =
  'Your thread starts with a message from your operator — the one who started it — carrying the task and ' +
  'any context already known; everything after it comes from the user unless labeled otherwise. The ' +
  "workspace may be shared by several people: user messages are prefixed with the speaker's name.";
