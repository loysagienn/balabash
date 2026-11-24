// Runs in the head of an extension page, before the stylesheet paints: the
// page starts in the theme it was in the last time (theme.ts keeps the copy
// this reads), or in the one the system's scheme picks. A plain script — no
// imports: it is loaded as it is.

(() => {
  try {
    const kept = localStorage.getItem('theme');
    const theme = kept && ['graphite', 'carbon', 'dusk', 'light', 'paper'].includes(kept) ? kept : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'graphite' : 'light';

    if (theme !== 'graphite') {
      document.documentElement.setAttribute('data-bb-theme', theme);
    }
  } catch {
    // Graphite.
  }
})();
