// The ids a field gives its control: the hint and the error below it are
// named by the field's id (`<fid>-h`, `<fid>-e`), so the control can point
// at them (aria-describedby, aria-errormessage) and a screen reader reads
// the hint with the control and the error when it appears.

export type FieldIds = {
  hintId?: string;
  errId?: string;
  // The space-separated ids for aria-describedby, in reading order: the
  // error first (it is the news), then the hint.
  describedBy?: string;
};

export function fieldIds(fid: string, has: { hint: boolean; err: boolean }): FieldIds {
  const hintId = has.hint ? `${fid}-h` : undefined;
  const errId = has.err ? `${fid}-e` : undefined;
  const describedBy = [errId, hintId].filter(Boolean).join(' ') || undefined;

  return { ...(hintId ? { hintId } : {}), ...(errId ? { errId } : {}), ...(describedBy ? { describedBy } : {}) };
}
