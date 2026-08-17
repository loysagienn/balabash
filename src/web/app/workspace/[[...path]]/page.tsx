'use client';

// The workspace file area page: a read-only window into the user's
// data/workspace/<userId>/files. The path lives in the URL (deep links and
// bookmarks work); one polymorphic /api/workspace/node request answers
// whether it names a directory (→ navigator) or a file (→ viewer). Viewers
// are a small registry by mediaType — markdown renders via react-markdown
// (raw HTML inside md stays unrendered, the library's default: files are
// agent-written, their content is not trusted); everything else shows an
// honest "no viewer" card with the metadata.

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import { ApiError, apiFetch } from '../../../lib/api';
import { useAuthRedirect } from '../../../lib/auth-gate';
import { formatDateTime } from '../../../lib/format';
import type { WorkspaceFileMeta, WorkspaceNodeResponse } from '../../../../api/contract.ts';
import styles from './workspace.module.css';

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

function DirListing({ relPath, directories, files }: { relPath: string; directories: string[]; files: WorkspaceFileMeta[] }) {
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
        <li key={`file:${file.path}`}>
          <Link className={styles.row} href={workspaceHref(file.path)}>
            <span className={styles.icon}>📄</span>
            <span className={styles.name}>{baseName(file.path)}</span>
            {file.title ? <span className={styles.fileTitle}>{file.title}</span> : null}
            <span className={styles.rowMeta}>
              <span className={styles.size}>{formatSize(file.sizeBytes)}</span>
              {file.modifiedAt ? <span className={styles.time}>{formatDateTime(new Date(file.modifiedAt))}</span> : null}
            </span>
            {file.description ? <span className={styles.description}>{file.description}</span> : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}

// The viewer registry: mediaType first, extension as the fallback. Only
// markdown for now — new viewers slot in here locally.
function pickViewer(file: WorkspaceFileMeta): 'markdown' | null {
  if (file.mediaType === 'text/markdown' || /\.(md|markdown)$/i.test(file.path)) {
    return 'markdown';
  }

  return null;
}

function MarkdownViewer({ relPath }: { relPath: string }) {
  const raw = useQuery({
    queryKey: ['workspace-raw', relPath],
    queryFn: async () => {
      // Plain fetch, not apiFetch: the body is raw text, not a JSON envelope.
      const response = await fetch(`/api/workspace/raw?path=${encodeURIComponent(relPath)}`, {
        credentials: 'same-origin',
      });

      if (!response.ok) {
        throw new ApiError(response.status, 'raw_failed', `HTTP ${response.status}`);
      }

      return response.text();
    },
  });

  // A 401 on the raw fetch leads to the login redirect, same as the API.
  const unauthorized = useAuthRedirect(raw.error);

  if (unauthorized || raw.isPending) {
    return <p className={styles.dim}>Загрузка файла…</p>;
  }

  if (raw.error) {
    return <p className={styles.error}>Не удалось загрузить файл: {raw.error.message}</p>;
  }

  return (
    <div className={`${styles.card} ${styles.markdown}`}>
      <ReactMarkdown>{raw.data}</ReactMarkdown>
    </div>
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
        </div>
        {file.description ? <p className={styles.description}>{file.description}</p> : null}
      </header>

      {viewer === 'markdown' ? (
        <MarkdownViewer relPath={file.path} />
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
