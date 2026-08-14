# Vendored skill: xlsx

The `xlsx/` directory beside this note is the official Anthropic xlsx skill,
vendored **strictly unchanged** (license: source-available; do not modify —
update by re-vendoring).

- Source: https://github.com/anthropics/skills — path `skills/xlsx`
- Commit: f6656c1256d5a8adfa37db9110046ef20bac644c
- Vendored: 2026-08-14

To update: clone the repo at current main, replace `xlsx/` wholesale with
`skills/xlsx`, verify with `diff -r`, and refresh the commit/date here.

Host dependencies the skill relies on (provisioned outside the repo):
apt: libreoffice (recalc.py runs it headless);
python: openpyxl, pandas, markitdown[docx,xlsx,pptx], defusedxml, lxml.
