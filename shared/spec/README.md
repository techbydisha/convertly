# Shared behaviour spec

Convertly has two front ends — the local macOS app (Python) and the browser
build (JavaScript) — and they have to behave identically. A page range typed on
a phone must select the same pages it would on the Mac, and a converted file
must come out with the same name.

These JSON files are the contract. Both implementations are tested against the
same cases, so neither can drift without a test going red.

| File | Covers |
| --- | --- |
| `page-ranges.json` | How `2-4`, `1,3,5-7`, `2-`, `3-1` and friends resolve, and which inputs are refused |
| `output-names.json` | What a converted or extracted file is called |
| `file-sizes.json` | How a byte count is shown to the user |
| `file-kinds.json` | Which extensions are accepted, and as what |

## Using it

Python reads these in `tests/test_shared_spec.py`. A JavaScript suite should
load the same files rather than restating the cases.

## Changing it

A change here is a change to user-visible behaviour in both front ends. Add the
case first, watch it fail, then make both sides satisfy it.

Rules worth keeping in mind:

- **Rounding is half-up.** Python's `round()` rounds half to even, so
  `round(2.5)` is `2` while JavaScript's `Math.round(2.5)` is `3`. Python uses
  `floor(x + 0.5)` to match. `file-sizes.json` pins this down.
- **Sizes are decimal** — 1 MB is 1,000,000 bytes, matching Finder and the
  limits upload sites quote.
- **Error messages are user-facing.** The spec checks that a message contains
  the useful part (the real page count, say) rather than matching it word for
  word, so wording can improve without breaking the contract.
