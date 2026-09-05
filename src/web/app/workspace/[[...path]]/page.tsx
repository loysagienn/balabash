'use client';

// The workspace file area page: a read-only window into the user's
// data/workspace/<userId>/files. The path lives in the URL (deep links and
// bookmarks work); one polymorphic /api/workspace/node request answers
// whether it names a directory (→ navigator) or a file (→ viewer). Viewers
// are a small registry: markdown renders via react-markdown (raw HTML inside
// md stays unrendered, the library's default: files are agent-written, their
// content is not trusted); any other text file — scripts, configs, JSON,
// HTML as source — shows in the code viewer with syntax highlighting (the
// grammar registry lives in lib/highlight.ts); everything else shows an
// honest "no viewer" card with the metadata.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import { ApiError, apiFetch } from '../../../lib/api';
import { useAuthRedirect } from '../../../lib/auth-gate';
import { formatDateTime } from '../../../lib/format';
import { aliases, detectLanguage, formatJson, highlightToReact, languages } from '../../../lib/highlight';
import type { WorkspaceFileMeta, WorkspaceNodeResponse } from '../../../../api/contract.ts';
import styles from './workspace.module.css';

// Text viewers refuse files above this size outright (the download link is
// the way) and skip highlighting above the smaller bound — the grammars are
// regex-driven and a multi-megabyte log would freeze the tab.
const VIEW_LIMIT_BYTES = 1024 * 1024;
const HIGHLIGHT_LIMIT_BYTES = 300 * 1024;

// Fenced blocks in markdown go through the same grammar registry as the
// code viewer; `txt`/`text` fences stay plain on purpose.
const rehypePlugins: React.ComponentProps<typeof ReactMarkdown>['rehypePlugins'] = [
  [rehypeHighlight, { languages, aliases, plainText: ['txt', 'text', 'plain'] }],
];

// useParams keeps catch-all segments URL-encoded; a malformed escape falls
// back to the raw segment instead of crashing the page.
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function workspaceHref(relPath: string): string {
  return relPath ? `/workspace/${relPath.split('/').map(encodeURIComponent).join('/')}` : '/workspace';
}

// The raw twin of workspaceHref: /files/<path> streams the bytes (inline);
// {download: true} makes the browser save the file. Always plain hrefs —
// downloading is the browser's job, never fetch+blob.
function filesHref(relPath: string, options?: { download?: boolean }): string {
  const base = `/files/${relPath.split('/').map(encodeURIComponent).join('/')}`;

  return options?.download ? `${base}?download=1` : base;
}

function formatSize(bytes: number | null): string {
  if (bytes === null) {
    return '—';
  }

  if (bytes < 1024) {
    return `${bytes} Б`;
  }

  let value = bytes;

  for (const unit of ['КБ', 'МБ', 'ГБ']) {
    value /= 1024;

    if (value < 1024) {
      return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} ${unit}`;
    }
  }

  return `${Math.round(value)} ТБ`;
}

function baseName(relPath: string): string {
  return relPath.split('/').pop() ?? relPath;
}

function Breadcrumbs({ relPath }: { relPath: string }) {
  const segments = relPath ? relPath.split('/') : [];

  return (
    <nav className={styles.crumbs}>
      {segments.length === 0 ? (
        <span className={styles.crumbCurrent}>Workspace</span>
      ) : (
        <Link className={styles.crumb} href="/workspace">
          Workspace
        </Link>
      )}
      {segments.map((segment, index) => {
        const isLast = index === segments.length - 1;
        const target = segments.slice(0, index + 1).join('/');

        return (
          <span key={target} className={styles.crumbs}>
            <span className={styles.crumbSep}>/</span>
            {isLast ? (
              <span className={styles.crumbCurrent}>{segment}</span>
            ) : (
              <Link className={styles.crumb} href={workspaceHref(target)}>
                {segment}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}

function DirListing({
  relPath,
  directories,
  files,
}: {
  relPath: string;
  directories: string[];
  files: WorkspaceFileMeta[];
}) {
  if (directories.length === 0 && files.length === 0) {
    return <p className={styles.dim}>Папка пуста.</p>;
  }

  return (
    <ul className={styles.list}>
      {directories.map(name => (
        <li key={`dir:${name}`}>
          <Link className={styles.row} href={workspaceHref(relPath ? `${relPath}/${name}` : name)}>
            <span className={styles.icon}>📁</span>
            <span className={styles.name}>{name}</span>
          </Link>
        </li>
      ))}
      {files.map(file => (
        // Nested <a> is invalid HTML, so the bordered row is the <li> itself:
        // the navigation link and the download icon sit side by side in it.
        <li key={`file:${file.path}`} className={`${styles.row} ${styles.fileRow}`}>
          <Link className={styles.rowLink} href={workspaceHref(file.path)}>
            <span className={styles.icon}>📄</span>
            <span className={styles.name}>{baseName(file.path)}</span>
            {file.title ? <span className={styles.fileTitle}>{file.title}</span> : null}
            <span className={styles.rowMeta}>
              <span className={styles.size}>{formatSize(file.sizeBytes)}</span>
              {file.modifiedAt ? (
                <span className={styles.time}>{formatDateTime(new Date(file.modifiedAt))}</span>
              ) : null}
            </span>
            {file.description ? <span className={styles.description}>{file.description}</span> : null}
          </Link>
          <a
            className={styles.rowDownload}
            href={filesHref(file.path, { download: true })}
            title="Скачать"
            aria-label={`Скачать ${baseName(file.path)}`}
          >
            ⬇
          </a>
        </li>
      ))}
    </ul>
  );
}

// The viewer registry: markdown by mediaType/extension first, then any file
// the grammar registry recognizes as text goes to the code viewer with that
// grammar. New viewers slot in here locally.
type Viewer = { kind: 'markdown' } | { kind: 'code'; language: string } | null;

function pickViewer(file: WorkspaceFileMeta): Viewer {
  if (file.mediaType === 'text/markdown' || /\.(md|markdown)$/i.test(file.path)) {
    return { kind: 'markdown' };
  }

  const language = detectLanguage(file);

  return language ? { kind: 'code', language } : null;
}

// The text of one workspace file over the raw byte surface. Plain fetch, not
// apiFetch: the body is raw text, not a JSON envelope. A 401 here leads to
// the login redirect, same as the API.
function useRawFile(relPath: string, { enabled = true }: { enabled?: boolean } = {}) {
  const raw = useQuery({
    queryKey: ['workspace-file', relPath],
    enabled,
    queryFn: async () => {
      const response = await fetch(filesHref(relPath), {
        credentials: 'same-origin',
      });

      if (!response.ok) {
        throw new ApiError(response.status, 'raw_failed', `HTTP ${response.status}`);
      }

      return response.text();
    },
  });

  const unauthorized = useAuthRedirect(raw.error);

  return { ...raw, unauthorized };
}

function TooLargeCard({ file }: { file: WorkspaceFileMeta }) {
  return (
    <div className={styles.card}>
      <p className={styles.dim}>
        Файл слишком большой для просмотра ({formatSize(file.sizeBytes)}, предел {formatSize(VIEW_LIMIT_BYTES)}).{' '}
        <a href={filesHref(file.path, { download: true })}>Скачать</a>
      </p>
    </div>
  );
}

function MarkdownViewer({ file }: { file: WorkspaceFileMeta }) {
  const tooLarge = file.sizeBytes !== null && file.sizeBytes > VIEW_LIMIT_BYTES;
  const raw = useRawFile(file.path, { enabled: !tooLarge });

  if (tooLarge) {
    return <TooLargeCard file={file} />;
  }

  if (raw.unauthorized || raw.isPending) {
    return <p className={styles.dim}>Загрузка файла…</p>;
  }

  if (raw.error) {
    return <p className={styles.error}>Не удалось загрузить файл: {raw.error.message}</p>;
  }

  return (
    <div className={`${styles.card} ${styles.markdown} ${styles.hl}`}>
      <ReactMarkdown rehypePlugins={rehypePlugins}>{raw.data}</ReactMarkdown>
    </div>
  );
}

function CodeViewer({ file, language }: { file: WorkspaceFileMeta; language: string }) {
  const tooLarge = file.sizeBytes !== null && file.sizeBytes > VIEW_LIMIT_BYTES;
  const highlight = file.sizeBytes === null || file.sizeBytes <= HIGHLIGHT_LIMIT_BYTES;
  const raw = useRawFile(file.path, { enabled: !tooLarge });

  // Highlighting is the expensive step; memoized so a re-render of the page
  // (react-query refetch bookkeeping, navigation state) does not redo it.
  const content = useMemo(() => {
    if (raw.data === undefined) {
      return null;
    }

    const text = language === 'json' ? formatJson(raw.data) : raw.data;

    return highlight ? highlightToReact(language, text) : text;
  }, [raw.data, language, highlight]);

  if (tooLarge) {
    return <TooLargeCard file={file} />;
  }

  if (raw.unauthorized || raw.isPending) {
    return <p className={styles.dim}>Загрузка файла…</p>;
  }

  if (raw.error) {
    return <p className={styles.error}>Не удалось загрузить файл: {raw.error.message}</p>;
  }

  return (
    <>
      {highlight ? null : (
        <p className={styles.viewerNote}>
          Подсветка синтаксиса отключена: файл больше {formatSize(HIGHLIGHT_LIMIT_BYTES)}.
        </p>
      )}
      <div className={`${styles.card} ${styles.codeCard}`}>
        <pre className={`${styles.code} ${styles.hl}`}>
          <code>{content}</code>
        </pre>
      </div>
    </>
  );
}

function FileView({ file }: { file: WorkspaceFileMeta }) {
  const viewer = pickViewer(file);

  return (
    <>
      <header className={styles.fileHeader}>
        <h1 className={styles.fileName}>{file.title ?? baseName(file.path)}</h1>
        <div className={styles.fileMeta}>
          <span className={styles.mediaType}>{file.mediaType}</span>
          <span className={styles.size}>{formatSize(file.sizeBytes)}</span>
          {file.modifiedAt ? <span className={styles.time}>{formatDateTime(new Date(file.modifiedAt))}</span> : null}
          <a className={styles.download} href={filesHref(file.path, { download: true })}>
            Скачать
          </a>
        </div>
        {file.description ? <p className={styles.description}>{file.description}</p> : null}
      </header>

      {viewer?.kind === 'markdown' ? (
        <MarkdownViewer file={file} />
      ) : viewer?.kind === 'code' ? (
        <CodeViewer file={file} language={viewer.language} />
      ) : (
        <div className={styles.card}>
          <p className={styles.dim}>Просмотр файлов этого типа пока недоступен.</p>
        </div>
      )}
    </>
  );
}

export default function WorkspacePage() {
  const params = useParams<{ path?: string[] }>();
  const relPath = (params.path ?? []).map(decodeSegment).join('/');

  const node = useQuery({
    queryKey: ['workspace-node', relPath],
    queryFn: () => apiFetch<WorkspaceNodeResponse>(`/api/workspace/node?path=${encodeURIComponent(relPath)}`),
  });

  const unauthorized = useAuthRedirect(node.error);
  const notFound = node.error instanceof ApiError && node.error.status === 404;

  if (unauthorized || node.isPending) {
    return (
      <main className={styles.main}>
        <p className={styles.dim}>Загрузка…</p>
      </main>
    );
  }

  if (notFound) {
    return (
      <main className={styles.main}>
        <Link className={styles.back} href="/workspace">
          ← Workspace
        </Link>
        <p className={styles.error}>Такого пути в workspace нет.</p>
      </main>
    );
  }

  if (node.error) {
    return (
      <main className={styles.main}>
        <Link className={styles.back} href="/workspace">
          ← Workspace
        </Link>
        <p className={styles.error}>Не удалось загрузить: {node.error.message}</p>
      </main>
    );
  }

  const data = node.data;

  return (
    <main className={styles.main}>
      <Link className={styles.back} href="/">
        ← Треды
      </Link>

      <Breadcrumbs relPath={data.path} />

      {data.kind === 'dir' ? (
        <DirListing relPath={data.path} directories={data.directories} files={data.files} />
      ) : (
        <FileView file={data.file} />
      )}
    </main>
  );
}
