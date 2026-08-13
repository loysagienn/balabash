# Vendored skill: pptx

The `pptx/` directory beside this note is the official Anthropic pptx skill,
vendored **strictly unchanged** (license: source-available; do not modify —
update by re-vendoring).

- Source: https://github.com/anthropics/skills — path `skills/pptx`
- Commit: f6656c1256d5a8adfa37db9110046ef20bac644c
- Vendored: 2026-08-13

To update: clone the repo at current main, replace `pptx/` wholesale with
`skills/pptx`, verify with `diff -r`, and refresh the commit/date here.

Host dependencies the skill relies on (provisioned outside the repo):
apt: libreoffice, poppler-utils, ttf-mscorefonts-installer,
fonts-crosextra-carlito, fonts-crosextra-caladea;
python: markitdown[pptx], Pillow, defusedxml, lxml;
node: pptxgenjs (resolvable from the pptx agent's working directory).
