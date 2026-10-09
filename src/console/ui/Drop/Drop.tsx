// Drop zone (design: Drop): a frame over the file list while files are
// dragged — where they will land (the folder path) and how many. Absolute
// inside the file area (.fa is position: relative); shown by the feature
// for the time of the drag.

import { Icon } from '../Icon/Icon.tsx';
import { Code } from '../atoms/atoms.tsx';
import './Drop.css';

export function Drop({ path, sub }: { path: string; sub?: string }) {
  return (
    <div className="drop">
      <Icon name="upload-cloud" />
      <span>
        Drop to upload to <Code>{path}</Code>
      </span>
      {sub ? <small className="drop-sub">{sub}</small> : null}
    </div>
  );
}
