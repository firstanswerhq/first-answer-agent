// Pure helper shared by the dashboard and its tests.
// Is the assistant still working on this inquiry? Owner-alert steps are appended after "Done" (the network call
// finishes later), so they are ignored when looking for the last real step.
export function isWorking(l) {
  if (l.status === 'new') return true;
  const real = (l.timeline || []).filter((t) => t.kind !== 'alert');
  if (!real.length) return false;
  return !['done', 'followup', 'info'].includes(real.at(-1).kind);
}
