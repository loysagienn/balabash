export function describeFinishRequest(event: { actor: string; payload: Record<string, unknown> }): string {
  const who = event.actor === 'user' ? 'The user asks' : 'Your operator asks';

  return (
    `[${who} you to finish this thread]\n` +
    'Wrap up now: start nothing new, bring what is in flight to a safe stop, write your final report and ' +
    'end the thread with end_thread in this turn.'
  );
}
