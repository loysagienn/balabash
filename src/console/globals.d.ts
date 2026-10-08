// Side-effect CSS imports of the console (main.tsx imports styles.css):
// esbuild bundles them into the entry's CSS file; for tsc they are modules
// with no exports.
declare module '*.css';
