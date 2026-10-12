// The words of the image viewer: the details line — the size first, the
// natural size of the loaded image next to it, then who and when
// ("2.1 MiB · 4032 × 3024 · you → manager, 17:04").

export function viewerMeta(meta: string[], size: { width: number; height: number } | null): string {
  const parts = [...meta];

  if (size) {
    parts.splice(parts.length > 0 ? 1 : 0, 0, `${size.width} × ${size.height}`);
  }

  return parts.join(' · ');
}
