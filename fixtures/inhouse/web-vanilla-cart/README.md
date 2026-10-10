# web-vanilla-cart

In-house fixture: a small shop with a catalog, a cart, and a checkout, in plain HTML and ES
modules with no build step. It exists to exercise the shared WebAssembly core: `pricing.js`
is about 150 lines of pure, deterministic money logic (volume tiers, coupons with categories
and minimums, region tax and shipping, half-away-from-zero rounding in cents, receipt
formatting) that a port must reproduce exactly on every platform.

- Screens: `#/` catalog, `#/cart`, `#/checkout`.
- State persisted in `localStorage` under `cart.state` as `{"lines":[{"sku","qty"}],"region","coupon"}`.
- Every interactive element carries a `data-testid`.

Serve the directory with any static server (for example `npx serve .`) and open `index.html`.
