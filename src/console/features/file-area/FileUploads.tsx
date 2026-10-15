// Uploads of the file area (design: Upload, UploadItem, Drop, ClashItem;
// rule 23): the corner panel of the uploads in the store — rows with
// cancel, retry and remove, a done row opening its file, "Fold" to one line
// while anything runs, "×" once all is over — and the dialog of the names
// already taken, one answer for all of them: Skip, Replace, Keep both (a
// modal when wide, a sheet on the phone; "×" is Skip). The panel shows on
// every file area while there are uploads (Files and a project's page),
// floating over the frame beside the area (FileBrowser); the dialog —
// wherever it was asked.

import { useRef } from 'react';
import type { AppRoute } from '../../lib/router/routes.ts';
import { useLinkTargets } from '../../lib/router/Link.tsx';
import { useNow } from '../../lib/format/useNow.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { answerClash, cancelUpload, closeUploads, foldUploads, retryUpload } from '../../store/uploads/actions.ts';
import { selectUploads } from '../../store/uploads/selectors.ts';
import { isRunning } from '../../store/uploads/reducer.ts';
import { useNarrowShell } from '../../ui/Dialog/Dialog.tsx';
import { Clash, ClashItem } from '../../ui/ClashItem/ClashItem.tsx';
import { Modal } from '../../ui/Modal/Modal.tsx';
import { Sheet } from '../../ui/Sheet/Sheet.tsx';
import { Upload, UploadItem } from '../../ui/Upload/Upload.tsx';
import { Code } from '../../ui/atoms/atoms.tsx';
import { fileIcon } from '../../ui/atoms/fileIcon.ts';
import { clashMeta, clashTitle, keptNames, panelWords, rowWords } from './uploads.logic.ts';
import './FileUploads.css';

export type FileUploadsProps = {
  // The route of a placed file (the owner's when it is under its root).
  routeFor: (path: string) => AppRoute;
  // How the root folder is named ('' — "Files").
  rootLabel: string;
};

export function UploadPanel({ routeFor, rootLabel }: FileUploadsProps) {
  const dispatch = useAppDispatch();
  const linkTarget = useLinkTargets();
  const { rows, folder, folded, clashes } = useAppSelector(selectUploads);

  if (rows.length === 0) {
    return null;
  }

  const words = panelWords(rows);

  return (
    <Upload
      path={folder || rootLabel}
      title={words.title}
      finished={words.finished}
      folded={folded}
      count={words.count}
      failed={words.failed}
      progress={words.progress}
      onFold={value => dispatch(foldUploads(value))}
      onClose={() => dispatch(closeUploads())}
      className="fil-upl"
      clash={clashes.length > 0}
    >
      {rows.map(row => {
        const item = rowWords(row);
        const link = row.path ? linkTarget(routeFor(row.path)) : null;

        return (
          <UploadItem
            key={row.id}
            icon={fileIcon(row.name, row.type.startsWith('image/'))}
            name={item.name}
            status={item.status}
            progress={item.progress}
            state={item.state}
            retry={item.retry}
            href={link?.href}
            onOpen={link?.onClick}
            onRetry={() => dispatch(retryUpload(row.id))}
            onRemove={() => dispatch(cancelUpload(row.id))}
          />
        );
      })}
    </Upload>
  );
}

export function ClashDialog({ rootLabel }: { rootLabel: string }) {
  const dispatch = useAppDispatch();
  const now = useNow();
  const probe = useRef<HTMLSpanElement>(null);
  const narrow = useNarrowShell(probe);
  const { clashes, rows, taken } = useAppSelector(selectUploads);

  if (clashes.length === 0) {
    return (
      <>
        <span ref={probe} className="dialog-probe" hidden />
        {null}
      </>
    );
  }

  const folder = clashes[0]?.folder ?? '';
  const where = folder || rootLabel;
  const kept = keptNames(clashes, taken);
  const others = rows.filter(isRunning).length;
  const title = clashTitle(clashes);
  const skip = () => dispatch(answerClash('skip'));
  const list = (
    <Clash>
      {clashes.map(clash => (
        <ClashItem key={clash.id} icon={fileIcon(clash.name, clash.type.startsWith('image/'))} name={clash.name} meta={clashMeta(clash, now)} />
      ))}
    </Clash>
  );
  const keepNote = (
    <>
      Keep both saves the new {kept.length === 1 ? 'one' : 'ones'} as{' '}
      {kept.map((name, i) => (
        <span key={name}>
          {i > 0 ? (i === kept.length - 1 ? ' and ' : ', ') : null}
          <Code>{name}</Code>
        </span>
      ))}
      .
    </>
  );

  return (
    <>
      <span ref={probe} className="dialog-probe" hidden />
      {narrow === null ? null : narrow ? (
        <Sheet label="Name clash" title={title} confirm="Keep both" alt="Replace" cancel="Skip" onConfirm={() => dispatch(answerClash('keep'))} onAlt={() => dispatch(answerClash('replace'))} onClose={skip}>
          <p className="fil-clash-note">
            in <Code>{where}</Code> · {keepNote}
          </p>
          {list}
        </Sheet>
      ) : (
        <Modal title={title} cancel="Skip" alt="Replace" confirm="Keep both" width="520px" onConfirm={() => dispatch(answerClash('keep'))} onAlt={() => dispatch(answerClash('replace'))} onClose={skip}>
          <Code>{where}</Code> already has {clashes.length === 1 ? 'a file with this name' : 'files with these names'}.
          {others > 0 ? ` The other ${others === 1 ? 'file is' : `${others} files are`} uploading.` : null}
          {list}
          <p className="fil-clash-note">{keepNote}</p>
        </Modal>
      )}
    </>
  );
}
