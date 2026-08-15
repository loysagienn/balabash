// The output channel of a topic-bound session agent: how a turn's final text
// reaches the user.
import { TELEGRAM_MARKDOWN_NOTE } from './telegram-markdown.ts';

export const TELEGRAM_OUTPUT_NOTE =
  'How your output reaches the user: the final text of each of your turns is sent into the topic. ' +
  `Keep it in the user's language. ${TELEGRAM_MARKDOWN_NOTE} Never end a turn with empty final text.`;
