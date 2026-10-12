// The file area with a root (design rule 17): the whole workspace folder in
// "Files", a project's folder on its page. The path is the route; the node
// behind it (Query) decides what is shown — a folder is the list, a file is
// the list of its folder with the row selected and the preview beside it
// (one pane at a time when the area is narrow, FileArea); with `edit` in
// the route a Markdown file is its editor at the full width (FileEditor).
// Links are routes the owner builds (routeFor), so the same component
// serves both roots.
// Query keeps older data through a failed refetch: a 404 still means the
// path is gone, any other failure keeps the rows under a banner with Retry.

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { WorkspaceFileMeta, WorkspaceFolderMeta } from '../../../api/contract.ts';
import type { AppRoute } from '../../lib/router/routes.ts';
import { useLinkProps, useLinkTargets } from '../../lib/router/Link.tsx';
import { useAppDispatch } from '../../store/hooks.ts';
import { routeTo } from '../../store/router/actions.ts';
import { countOf, fileSize, fileTimeLabel, folderTimeLabel } from '../../lib/format/index.ts';
import { pick } from '../../lib/upload/pick.ts';
import { useFileDrop } from '../../lib/upload/useFileDrop.ts';
import { uploadFiles } from '../../store/uploads/actions.ts';
import type { ExistingEntry } from '../../store/uploads/actions.ts';
import { Btn } from '../../ui/Btn/Btn.tsx';
import { Drop } from '../../ui/Drop/Drop.tsx';
import { IconBtn } from '../../ui/IconBtn/IconBtn.tsx';
import { useNow } from '../../lib/format/useNow.ts';
import { Crumbs } from '../../ui/Crumbs/Crumbs.tsx';
import type { Crumb } from '../../ui/Crumbs/Crumbs.tsx';
import { Empty } from '../../ui/Empty/Empty.tsx';
import { FaBar, FaFoot, FaList, FaNote, FaPreview, FaRows, FileArea, FileListHead } from '../../ui/FileArea/FileArea.tsx';
import { FileRow } from '../../ui/FileRow/FileRow.tsx';
import type { IconName } from '../../ui/Icon/Icon.tsx';
import { Note } from '../../ui/Note/Note.tsx';
import { SkelRow } from '../../ui/Skel/Skel.tsx';
import { fileIcon } from '../../ui/atoms/fileIcon.ts';
import { canEdit, editedFile } from './editor.logic.ts';
import { FileEditor } from './FileEditor.tsx';
import { FileMenu } from './FileMenu.tsx';
import { FilePreview } from './FilePreview.tsx';
import { ClashDialog, UploadPanel } from './FileUploads.tsx';
import { crumbSegments, folderCaption, isNotFound, joinPath, listingSummary, nameOf, nodeOf, parentOf, underRoot } from './node.ts';
import type { DirListing } from './node.ts';
import { useWorkspaceNode } from './queries.ts';

export type FileBrowserProps = {
  // The folder the area cannot leave ('' — the whole file area).
  root: string;
  rootLabel: string;
  lead?: IconName;
  // The current path (a folder or a file), at or below the root.
  path: string;
  // The editor over the file at the path (ignored for a file it cannot edit).
  view?: 'edit';
  routeFor: (path: string, view?: 'edit') => AppRoute;
  // Pinned files of a project, above the rows.
  pins?: ReactNode;
  className?: string;
};

const SKELETON = [
  [40, 70],
  [55, 30],
  [35, 60],
  [50, 40],
];

// A folder's row: what it holds as the caption, the day it changed as the
// time; a folder has no size.
function DirRow({ folder, now, routeFor }: { folder: WorkspaceFolderMeta; now: Date; routeFor: (path: string) => AppRoute }) {
  const link = useLinkProps(routeFor(folder.path));

  return (
    <FileRow
      name={nameOf(folder.path)}
      dir
      caption={folderCaption(folder)}
      size="—"
      time={folder.modifiedAt ? folderTimeLabel(new Date(folder.modifiedAt), now) : undefined}
      {...link}
    />
  );
}

function Row({ file, selected, now, routeFor }: { file: WorkspaceFileMeta; selected: boolean; now: Date; routeFor: (path: string) => AppRoute }) {
  const link = useLinkProps(routeFor(file.path));
  const name = nameOf(file.path);

  return (
    <FileRow
      name={name}
      icon={fileIcon(name, file.mediaType.startsWith('image/'))}
      caption={file.title ?? undefined}
      size={file.sizeBytes === null ? undefined : fileSize(file.sizeBytes)}
      time={file.modifiedAt ? fileTimeLabel(new Date(file.modifiedAt), now) : undefined}
      selected={selected}
      more={<FileMenu path={file.path} />}
      {...link}
    />
  );
}

function Rows({ listing, selectedPath, now, routeFor, onUpload }: { listing: DirListing; selectedPath: string | null; now: Date; routeFor: (path: string) => AppRoute; onUpload?: () => void }) {
  if (listing.folders.length === 0 && listing.files.length === 0) {
    return (
      <Empty icon="folder-open" title="Folder is empty" action={onUpload ? 'Upload' : undefined} actionIcon="upload" onAction={onUpload}>
        {onUpload ? 'Drag files here or use the button to upload. Agents put their results here too.' : 'Agents put their results here.'}
      </Empty>
    );
  }

  return (
    <>
      <FileListHead />
      <FaRows>
        {listing.folders.map(folder => (
          <DirRow key={`d:${folder.path}`} folder={folder} now={now} routeFor={routeFor} />
        ))}
        {listing.files.map(file => (
          <Row key={file.path} file={file} selected={file.path === selectedPath} now={now} routeFor={routeFor} />
        ))}
      </FaRows>
      <FaFoot>{listingSummary(listing)}</FaFoot>
    </>
  );
}

export function FileBrowser({ root, rootLabel, lead, path, view, routeFor, pins, className }: FileBrowserProps) {
  const now = useNow();
  const dispatch = useAppDispatch();
  const linkTarget = useLinkTargets();
  const node = useWorkspaceNode(path);
  const answer = nodeOf(node);
  // A file's list is its folder's listing — a second node, shared with the
  // folder's own screen through the query key.
  const parent = useWorkspaceNode(parentOf(path), answer?.kind === 'file');
  // The path is gone (a 404 of the node or of a file's folder) whatever
  // Query still holds from before.
  const gone = answer === null ? isNotFound(node.error) : answer.kind === 'file' && isNotFound(parent.error);
  const loadedFile = !gone && answer?.kind === 'file' ? answer.file : null;
  // The file under the editor is held: once the editor is open at a path,
  // a refetch that finds the file gone or no longer editable (grown past
  // the preview's limit) does not unmount it under a draft — the editor
  // keeps the last editable node and reports what it finds when it saves
  // (editedFile). Dropped on leaving the editor or the path.
  const [held, setHeld] = useState<WorkspaceFileMeta | null>(null);
  const edited = editedFile(view, loadedFile, held, path);

  useEffect(() => {
    setHeld(edited);
  }, [edited]);

  const file = loadedFile ?? edited;
  const kind = file ? 'file' : gone ? null : answer?.kind ?? null;
  const editing = edited !== null;
  const listPath = kind === 'file' ? parentOf(path) : path;
  const listQuery = kind === 'file' ? parent : node;
  const listing = !gone && listQuery.data?.kind === 'dir' ? listQuery.data : null;
  // A refetch that failed behind the shown listing (Query keeps the data):
  // the rows stay, a banner says so and retries the query that failed.
  const stale = listing ? (listQuery.error ? listQuery : kind === 'file' && node.error ? node : null) : null;
  // The breadcrumbs: the root, then the folders above the current one.
  const segments = crumbSegments(root, listPath);
  const current = segments[segments.length - 1] ?? rootLabel;
  const crumbs: Crumb[] = segments.length === 0 ? [] : [{ label: rootLabel, ...linkTarget(routeFor(root)) }];

  for (let i = 0; i < segments.length - 1; i += 1) {
    crumbs.push({ label: segments[i] as string, ...linkTarget(routeFor(joinPath(root, ...segments.slice(0, i + 1)))) });
  }

  // Where a link of the preview leads (a relative link of a Markdown file):
  // the owner's route while the path stays under the root; one that climbs
  // out of it (../ from a project's folder) is the Files section's.
  const linkRoute = (target: string): AppRoute => (underRoot(root, target) ? routeFor(target) : { key: 'files', path: target });

  // Uploads (design rule 23): into the folder shown — the Upload button
  // (the system picker), files dropped anywhere over the area, the empty
  // folder's Upload. The listing's names are what a clash is checked
  // against; the editor and a path that is gone take nothing.
  const picker = useRef<HTMLInputElement>(null);
  const canUpload = !gone && !editing && kind !== null && (kind === 'dir' || listing !== null);
  const upload = (files: File[]) => {
    const existing: ExistingEntry[] = listing
      ? [
          ...listing.files.map(entry => ({ name: nameOf(entry.path), sizeBytes: entry.sizeBytes, modifiedAt: entry.modifiedAt, folder: false })),
          ...listing.folders.map(entry => ({ name: nameOf(entry.path), sizeBytes: null, modifiedAt: entry.modifiedAt, folder: true })),
        ]
      : [];

    dispatch(uploadFiles(listPath, pick(files), existing));
  };
  const openPicker = () => picker.current?.click();
  const { drag, handlers: dropHandlers } = useFileDrop(canUpload, upload);
  const uploadButtons = canUpload ? (
    <>
      <Btn label="Upload" icon="upload" size="sm" className="fil-up-btn" onClick={openPicker} />
      <IconBtn icon="upload" label="Upload" size="sm" className="fil-up-icon" onClick={openPicker} />
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={event => {
          const files = Array.from(event.currentTarget.files ?? []);

          event.currentTarget.value = '';

          if (files.length > 0) {
            upload(files);
          }
        }}
      />
    </>
  ) : undefined;

  let body;

  if (gone) {
    body = (
      <Empty icon="folder-open" state="err" title="Not found" action={rootLabel} actionIcon="arrow-left" onAction={() => dispatch(routeTo(routeFor(root)))}>
        There is no <code className="code">{path}</code> in the file area.
      </Empty>
    );
  } else if (listing) {
    body = <Rows listing={listing} selectedPath={kind === 'file' ? path : null} now={now} routeFor={routeFor} onUpload={canUpload ? openPicker : undefined} />;
  } else if (listQuery.error) {
    body = (
      <Empty icon="cloud-off" state="err" title="Couldn’t load the folder" action="Retry" actionIcon="refresh-cw" onAction={() => void listQuery.refetch()}>
        {listQuery.error.message}
      </Empty>
    );
  } else {
    body = (
      <FaRows busy>
        {SKELETON.map((widths, i) => (
          <SkelRow key={i} widths={widths} pill={false} />
        ))}
      </FaRows>
    );
  }

  return (
    <FileArea view={kind === 'file' ? 'preview' : 'list'} split={kind === 'file' && !editing} drop={dropHandlers} className={className}>
      <FaList>
        <FaBar end={uploadButtons}>
          <Crumbs items={crumbs} current={current} lead={lead} fa />
        </FaBar>
        {pins}
        {stale ? (
          <FaNote>
            <Note state="err" icon="cloud-off" role="alert" action="Retry" actionIcon="refresh-cw" onAction={() => void stale.refetch()}>
              Couldn’t refresh: {stale.error?.message}
            </Note>
          </FaNote>
        ) : null}
        {body}
      </FaList>
      {file ? (
        <FaPreview>
          {editing ? (
            /* keyed by the path alone: the draft survives a new version of the file under it */
            <FileEditor key={edited.path} file={edited} exitRoute={routeFor(edited.path)} />
          ) : (
            /* keyed by the file and its version: the preview's own state (the image's size, a failed load) belongs to one file */
            <FilePreview
              key={`${file.path}@${file.modifiedAt ?? ''}`}
              file={file}
              now={now}
              routeFor={linkRoute}
              editRoute={canEdit(file) ? routeFor(file.path, 'edit') : undefined}
            />
          )}
        </FaPreview>
      ) : null}
      {drag ? <Drop path={listPath || rootLabel} sub={countOf(drag.count, 'file')} /> : null}
      <UploadPanel routeFor={linkRoute} rootLabel={rootLabel} />
      <ClashDialog rootLabel={rootLabel} />
    </FileArea>
  );
}
