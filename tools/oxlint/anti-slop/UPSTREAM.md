# anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop, commit `13909c9e07590f5a85d93c62712259fe14a883f7`
  (`skills/install-anti-slop/assets/anti-slop`, folder tree `97962dc9fad565ca7695bf57805d9d0138ce1def`).
- Installed paths: this directory, unchanged from that commit. `vendor/` keeps its own `LICENSE` and `UPSTREAM.md`.
- Registered in `.oxlintrc.json` as `anti-slop`; the Effect plugin is not registered (no `effect` dependency).
- Deviations: only some rules are enabled. Left off because they conflict with this repo's boundary validation or
  style: `no-runtime-typeof`, `no-unknown-parameters`, `no-unknown-returns`, `no-unknown-type-aliases`,
  `no-unsafe-dictionary-type`, `no-conditional-empty-object-spread`, `no-known-value-widening`,
  `no-shape-in-symbol-names`, `no-module-mocking`, `require-safety-comment-for-type-assertion`,
  `no-array-filter-map` (its fix needs iterator helpers, which Node 20 lacks), and `require-readable-spacing`
  (the repo has no formatter, and the autofix breaks one-line blocks).
