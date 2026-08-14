# Vendored skill: docx

The `docx/` directory beside this note is the official Anthropic docx skill,
vendored **strictly unchanged** (license: source-available; do not modify —
update by re-vendoring).

- Source: https://github.com/anthropics/skills — path `skills/docx`
- Commit: f6656c1256d5a8adfa37db9110046ef20bac644c
- Vendored: 2026-08-14

To update: clone the repo at current main, replace `docx/` wholesale with
`skills/docx`, verify with `diff -r`, and refresh the commit/date here.

Host dependencies the skill relies on (provisioned outside the repo):
apt: libreoffice, poppler-utils, pandoc;
python: defusedxml, lxml (validate.py/soffice.py helpers);
node: docx (resolvable from the workspace file area — installed in
data/workspace/package.json, like pptxgenjs for the pptx skill).
