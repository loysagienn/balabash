// Context fill (design: Ctx): a ring with a caption; with token counts the
// ring gets a hover tooltip "Context: 82k of 200k tokens" (in a thread row).

import { Hint, Tip } from '../Hint/Hint.tsx';
import { Ring } from './Ring.tsx';
import { ctxVals } from './Ring.logic.ts';
import type { CtxInput } from './Ring.logic.ts';

export type CtxProps = CtxInput & {
  // Replaces the "62%" caption.
  text?: string;
  className?: string;
};

export function Ctx({ text, className, ...input }: CtxProps) {
  const vals = ctxVals(input);
  const ring = (
    <span className={className ? `ctx ${className}` : 'ctx'}>
      <Ring value={vals.percent} />
      {text ?? vals.text}
    </span>
  );

  if (!vals.hint) {
    return ring;
  }

  return (
    <Hint label={vals.aria}>
      {ring}
      <Tip hint>
        Context: <b>{vals.hint}</b> tokens
      </Tip>
    </Hint>
  );
}
