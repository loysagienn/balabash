// One file in the preview panel: the header with the details and actions
// (download, copy path), the agent's caption and description when the
// file has them, and the body by type — Markdown rendered, code and text
// with line numbers, delimited text as a table, an image, a PDF; anything
// else or a text too large is a card with "Download". Text content comes
// through Query by path and modification time (queries.ts).

import { useMemo, useState } from 'react';
import type { WorkspaceFileMeta } from '../../../api/contract.ts';
import { fileUrl } from '../../lib/api/index.ts';
import { countOf, fileSize, startedLabel } from '../../lib/format/index.ts';
import { Btn } from '../../ui/Btn/Btn.tsx';
import { CodeView } from '../../ui/CodeView/CodeView.tsx';
import { CsvView } from '../../ui/CsvView/CsvView.tsx';
import { IconBtn } from '../../ui/IconBtn/IconBtn.tsx';
import { ImgView } from '../../ui/ImgView/ImgView.tsx';
import { Md } from '../../ui/Md/Md.tsx';
import { MetaCard } from '../../ui/MetaCard/MetaCard.tsx';
import { Note } from '../../ui/Note/Note.tsx';
import { PdfView } from '../../ui/PdfView/PdfView.tsx';
import { Pv, PvActBar, PvBody, PvHead, PvNote } from '../../ui/Pv/Pv.tsx';
import { SkelStack } from '../../ui/Skel/Skel.tsx';
import { fileIcon } from '../../ui/atoms/fileIcon.ts';
import { codeLines } from './codeLines.ts';
import { useCopyPath } from './copyPath.ts';
import { isNumeric, parseDelimited } from './csv.ts';
import { HIGHLIGHT_MAX, nameOf, viewerFor } from './node.ts';
import type { Viewer } from './node.ts';
import { useWorkspaceText } from './queries.ts';

// Rows of a table shown in the browser; the rest is counted.
const CSV_ROWS = 1000;
const SKELETON = [90, 70, 80, 40];

function readsText(viewer: Viewer): boolean {
  return viewer.kind === 'markdown' || viewer.kind === 'code' || viewer.kind === 'csv';
}

function TextBody({ file, viewer, text }: { file: WorkspaceFileMeta; viewer: Viewer; text: string }) {
  const lines = useMemo(
    () => (viewer.kind === 'code' ? codeLines(text, viewer.language, (file.sizeBytes ?? 0) <= HIGHLIGHT_MAX) : null),
    [file.sizeBytes, text, viewer],
  );
  const table = useMemo(() => (viewer.kind === 'csv' ? parseDelimited(text, viewer.delimiter, CSV_ROWS) : null), [text, viewer]);

  if (viewer.kind === 'markdown') {
    return <Md source={text} />;
  }
  if (lines) {
    return <CodeView lines={lines} />;
  }
  if (table) {
    return (
      <>
        {table.truncated ? (
          <Note icon="file-spreadsheet" role="status">
            Showing the first {countOf(table.rows.length, 'row')} of {table.total.toLocaleString('en-US')}; download the file for the rest.
          </Note>
        ) : null}
        <CsvView header={table.header} rows={table.rows} numeric={isNumeric} />
      </>
    );
  }

  return null;
}

export function FilePreview({ file, now }: { file: WorkspaceFileMeta; now: Date }) {
  const name = nameOf(file.path);
  const viewer = viewerFor(file);
  const copyPath = useCopyPath();
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const text = useWorkspaceText(file.path, file.modifiedAt, readsText(viewer));
  const icon = fileIcon(name, viewer.kind === 'image');
  const download = fileUrl(file.path, true);
  const meta: string[] = [];

  if (imageSize) {
    meta.push(`${imageSize.width} × ${imageSize.height}`);
  }
  if (file.sizeBytes !== null) {
    meta.push(fileSize(file.sizeBytes));
  }
  if (file.modifiedAt) {
    meta.push(`modified ${startedLabel(new Date(file.modifiedAt), now)}`);
  }

  let body;

  if (viewer.kind === 'image') {
    body = <ImgView src={fileUrl(file.path)} alt={file.title ?? name} onSize={setImageSize} />;
  } else if (viewer.kind === 'pdf') {
    body = <PdfView src={fileUrl(file.path)} title={name} />;
  } else if (viewer.kind === 'none') {
    body = (
      <MetaCard icon={icon} name={name} actions={<Btn label="Download" icon="download" size="sm" href={download} />}>
        {viewer.reason === 'size'
          ? `A ${file.sizeBytes === null ? 'large' : fileSize(file.sizeBytes)} text file is too large to preview in the browser. Download it or ask an agent to find what you need.`
          : `${file.mediaType}${file.sizeBytes === null ? '' : ` · ${fileSize(file.sizeBytes)}`}. No preview for this type.`}
      </MetaCard>
    );
  } else if (text.data !== undefined) {
    body = <TextBody file={file} viewer={viewer} text={text.data} />;
  } else if (text.error) {
    body = (
      <Note state="err" icon="cloud-off" role="alert" action="Retry" actionIcon="refresh-cw" onAction={() => void text.refetch()}>
        Couldn’t load the file: {text.error.message}
      </Note>
    );
  } else {
    body = (
      <div aria-busy="true">
        <SkelStack widths={SKELETON} />
      </div>
    );
  }

  return (
    <Pv>
      <PvHead icon={icon} name={name} path={file.path} meta={meta}>
        <IconBtn icon="download" label="Download" size="sm" href={download} />
        <IconBtn icon="copy" label="Copy path" size="sm" onClick={() => void copyPath(file.path)} />
      </PvHead>
      {file.title || file.description ? <PvNote title={file.title ?? name}>{file.description}</PvNote> : null}
      <PvBody>{body}</PvBody>
      <PvActBar>
        <Btn label="Download" icon="download" href={download} />
        <Btn label="Path" icon="copy" onClick={() => void copyPath(file.path)} />
      </PvActBar>
    </Pv>
  );
}
