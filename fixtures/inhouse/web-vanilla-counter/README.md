# web-vanilla-counter

The smallest in-house fixture: a build-less web app (plain HTML, one ES module, one stylesheet) with

- two screens behind a hash router: Counter (`#/`) and Settings (`#/settings`)
- state persisted in `localStorage` under `counter.state` as `{ "count": number, "step": number }`
- a little logic worth testing: count never goes below zero, step is clamped to 1–10, parity label

It exercises detection (static web app), inventory, spec and behavior extraction, and observation.
Every interactive element carries a `data-testid` so the factory can verify behaviors on the source.

Apache-2.0 licensed, like the rest of this repository.
