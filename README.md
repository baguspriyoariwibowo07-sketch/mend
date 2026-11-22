# mend

[![mend](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/baguspriyoariwibowo07-sketch/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/baguspriyoariwibowo07-sketch/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

One patch tool for every AI edit format. `mend` applies the edits AI models
write — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks,
the V4A patch format, and text-editor tool calls as JSON — to a tree of text
files, to one written specification (`SPEC.md`). It finds the lines an edit
names even when the model drifted their whitespace or indentation, and changes
every file or none.

```sh
node main.ts [options] [PATCH]
```

Node 22 and its standard library alone; no dependencies, no network, fully
deterministic. Practice score: **100/100** on the kit's practice set, plus
160 self-made adversarial checks covering the specification sentence by
sentence (CRLF, no-final-newline, `\ No newline at end of file`, empty-O
insertions, nearest-position hunks, V4A anchors/cursors, usage-error
precedence, `--check`/`--strict`, unsafe paths, atomicity).

Built for the [make.fun bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
"Build mend, one patch tool for every AI edit format".
