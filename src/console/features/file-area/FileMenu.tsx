// The "⋯" of a file row: download and copy the path (the same actions as
// the preview header).

import { useState } from 'react';
import { fileUrl } from '../../lib/api/index.ts';
import { IconBtn } from '../../ui/IconBtn/IconBtn.tsx';
import { Menu, MenuAnchor, MenuItem } from '../../ui/Menu/Menu.tsx';
import { useCopyPath } from './copyPath.ts';

export function FileMenu({ path }: { path: string }) {
  const [open, setOpen] = useState(false);
  const copyPath = useCopyPath();
  const close = () => setOpen(false);

  return (
    <MenuAnchor
      open={open}
      onClose={close}
      menu={
        <Menu label="File actions">
          <MenuItem
            icon="download"
            label="Download"
            onClick={() => {
              close();
              window.location.assign(fileUrl(path, true));
            }}
          />
          <MenuItem
            icon="copy"
            label="Copy path"
            onClick={() => {
              close();
              void copyPath(path);
            }}
          />
        </Menu>
      }
    >
      <IconBtn icon="ellipsis" label="File actions" size="sm" expanded={open} onClick={() => setOpen(!open)} />
    </MenuAnchor>
  );
}
