// The icon of a file by its name (design README, rule 19): images, code,
// spreadsheets, archives, documents, text — anything else is a plain file.

import type { IconName } from '../Icon/Icon.tsx';

const BY_EXT: Record<string, IconName> = {
  png: 'file-image',
  jpg: 'file-image',
  jpeg: 'file-image',
  gif: 'file-image',
  webp: 'file-image',
  svg: 'file-image',
  csv: 'file-spreadsheet',
  tsv: 'file-spreadsheet',
  xlsx: 'file-spreadsheet',
  xls: 'file-spreadsheet',
  zip: 'file-archive',
  gz: 'file-archive',
  tar: 'file-archive',
  '7z': 'file-archive',
  pdf: 'file-type',
  docx: 'file-type',
  doc: 'file-type',
  pptx: 'file-type',
  md: 'file-text',
  txt: 'file-text',
  log: 'file-text',
};

const CODE_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'css', 'html', 'xml', 'yml', 'yaml', 'py', 'sh', 'sql', 'prisma', 'toml', 'ini', 'env']);

export function fileIcon(name: string, image = false): IconName {
  if (image) {
    return 'file-image';
  }

  const ext = name.toLowerCase().split('.').pop() ?? '';

  return BY_EXT[ext] ?? (CODE_EXT.has(ext) ? 'file-code' : 'file-text');
}
