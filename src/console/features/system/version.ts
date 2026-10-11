// The label of the build the process runs (GET /api/system —
// ProcessVersionView): "3f9c21e", "3f9c21e+" when the tree held
// uncommitted changes at the build (the bundle is not that commit alone);
// null without a build stamp. Shared by the System screen and the shell's
// footer.

export function buildLabel(version: { commit: string | null; dirty?: boolean }): string | null {
  return version.commit ? `${version.commit}${version.dirty === true ? '+' : ''}` : null;
}
