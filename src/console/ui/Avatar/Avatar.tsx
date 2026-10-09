// Agent avatar (design: Avatar): the letter and the identity color are
// fixed per agent (agents.ts). pip — the session state dot on the corner.

import { avatarVals } from './agents.ts';
import './Avatar.css';

export type AvatarProps = {
  agent: string;
  size?: 'xs' | 'sm' | 'lg';
  pip?: 'run' | 'wait' | 'act' | 'err';
  className?: string;
};

export function Avatar({ agent, size, pip, className }: AvatarProps) {
  const vals = avatarVals(agent);

  return (
    <span className={className ? `av ${className}` : 'av'} data-id={vals.id} data-size={size} title={vals.title}>
      {vals.letter}
      {pip ? <i className="av-pip" data-state={pip} aria-hidden="true" /> : null}
    </span>
  );
}
