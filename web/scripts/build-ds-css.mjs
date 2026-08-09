// Builds the two stylesheets the design-system export ships, plus the fonts they
// reference. Kept as a script rather than a chain of shell commands because the
// two halves have to stay in step: `ds.css` compiles the utilities *without* the
// token values, so the token file has to travel with it or nothing resolves.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const DIST = 'ds-dist';
// The token layer ships as its own tiny package, and it lives OUTSIDE ds-dist on
// purpose. The converter finds the package root by walking up from the emitted
// `.d.ts` tree (ds-dist/types) to the nearest package.json carrying a name — a
// package.json inside ds-dist captures that walk and silently re-roots prop
// extraction, which surfaces later as components rendering wrong rather than as
// an error.
const TOKENS = 'ds-tokens';

// Emptied first: a face that has been swapped out would otherwise linger here and
// ship as a font nothing references.
rmSync(`${DIST}/files`, { recursive: true, force: true });
mkdirSync(`${DIST}/files`, { recursive: true });
mkdirSync(TOKENS, { recursive: true });

// 1. Utilities (no token values — see ds.css).
execFileSync('npx', ['tailwindcss', '-i', './ds.css', '-o', `./${DIST}/ds.css`, '--minify'], { stdio: 'inherit' });

// 2. The token layer, verbatim. It is plain CSS custom properties, so there is
//    nothing to compile — copying keeps the exported names byte-identical to the
//    ones the app itself uses.
cpSync('src/tokens.css', `${TOKENS}/tokens.css`);
writeFileSync(
  `${TOKENS}/package.json`,
  JSON.stringify({ name: 'warrden-ui-tokens', version: '0.0.0', private: true }, null, 2) + '\n',
);

// 3. Font binaries, so the @font-face urls in the compiled CSS resolve locally.
for (const family of ['instrument-sans', 'newsreader', 'geist-mono']) {
  cpSync(`node_modules/@fontsource-variable/${family}/files`, `${DIST}/files`, { recursive: true });
}
