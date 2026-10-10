import {
  CATALOG,
  MAX_QTY,
  REGIONS,
  clampQty,
  formatCents,
  normalizeLines,
  quote,
} from './pricing.js'

const STORAGE_KEY = 'cart.state'
const DEFAULTS = { lines: [], region: 'US', coupon: '' }

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw)
    return {
      lines: normalizeLines(parsed.lines),
      region: REGIONS[parsed.region] ? parsed.region : 'US',
      coupon: typeof parsed.coupon === 'string' ? parsed.coupon : '',
    }
  } catch {
    return { ...DEFAULTS }
  }
}

const state = loadState()

function save() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ lines: state.lines, region: state.region, coupon: state.coupon }),
  )
}

function update(patch) {
  Object.assign(state, patch)
  save()
  render()
}

const app = document.getElementById('app')
const navLinks = [...document.querySelectorAll('nav a')]

function currentRoute() {
  const hash = location.hash || '#/'
  return hash === '#/cart' ? 'cart' : hash === '#/checkout' ? 'checkout' : 'catalog'
}

function itemCount() {
  return state.lines.reduce((n, l) => n + l.qty, 0)
}

function renderCatalog() {
  const inCart = new Map(state.lines.map((l) => [l.sku, l.qty]))
  return `
    <section data-testid="screen-catalog">
      <h2>Catalog</h2>
      <ul class="catalog">
        ${CATALOG.map(
          (item) => `
          <li data-testid="item-${item.sku}">
            <span class="name">${item.name}</span>
            <span class="price" data-testid="price-${item.sku}">${formatCents(item.priceCents, state.region)}</span>
            <button type="button" data-add="${item.sku}" data-testid="add-${item.sku}">Add</button>
            <span class="muted" data-testid="in-cart-${item.sku}">${inCart.get(item.sku) ? `${inCart.get(item.sku)} in cart` : ''}</span>
          </li>`,
        ).join('')}
      </ul>
    </section>`
}

function renderCart() {
  const q = quote(state.lines, state.region, state.coupon)
  return `
    <section data-testid="screen-cart">
      <h2>Cart</h2>
      ${
        q.lines.length
          ? `<table class="lines">
              ${q.lines
                .map(
                  (l) => `
                <tr data-testid="line-${l.sku}">
                  <td>${l.name}</td>
                  <td><input type="number" min="1" max="${MAX_QTY}" value="${l.qty}" data-qty="${l.sku}" data-testid="qty-${l.sku}" aria-label="Quantity of ${l.name}" /></td>
                  <td data-testid="line-total-${l.sku}">${formatCents(l.lineCents, state.region)}</td>
                  <td><button type="button" data-remove="${l.sku}" data-testid="remove-${l.sku}">Remove</button></td>
                </tr>`,
                )
                .join('')}
            </table>
            <p class="row"><span>Subtotal</span><span data-testid="cart-subtotal">${formatCents(q.subtotalCents, state.region)}</span></p>
            <p class="row" data-testid="cart-volume-row" ${q.volumeDiscountCents ? '' : 'hidden'}><span>Volume discount</span><span data-testid="cart-volume">-${formatCents(q.volumeDiscountCents, state.region)}</span></p>
            <p><a href="#/checkout" data-testid="go-checkout">Checkout</a></p>`
          : `<p class="muted" data-testid="cart-empty">Your cart is empty.</p>`
      }
    </section>`
}

function renderCheckout() {
  const q = quote(state.lines, state.region, state.coupon)
  const couponMessage =
    q.couponReason === 'applied'
      ? `Coupon ${q.couponCode} applied`
      : q.couponReason === 'unknown'
        ? 'Unknown coupon code'
        : q.couponReason === 'minimum'
          ? 'Order too small for this coupon'
          : q.couponReason === 'ineligible'
            ? 'Nothing in the cart qualifies for this coupon'
            : ''
  return `
    <section data-testid="screen-checkout">
      <h2>Checkout</h2>
      <label>Ship to
        <select data-testid="region-select" aria-label="Region">
          ${Object.entries(REGIONS)
            .map(
              ([code, r]) =>
                `<option value="${code}" ${code === state.region ? 'selected' : ''}>${r.label}</option>`,
            )
            .join('')}
        </select>
      </label>
      <label>Coupon
        <input type="text" value="${state.coupon}" data-testid="coupon-input" aria-label="Coupon code" />
      </label>
      <button type="button" data-testid="apply-coupon">Apply</button>
      <p class="muted" data-testid="coupon-message">${couponMessage}</p>
      <dl class="receipt">
        <dt>Subtotal</dt><dd data-testid="subtotal">${formatCents(q.subtotalCents, state.region)}</dd>
        <dt>Volume discount</dt><dd data-testid="volume-discount">-${formatCents(q.volumeDiscountCents, state.region)}</dd>
        <dt>Coupon</dt><dd data-testid="coupon-discount">-${formatCents(q.couponCents, state.region)}</dd>
        <dt>Shipping</dt><dd data-testid="shipping">${q.shippingCents === 0 && q.lines.length ? 'Free' : formatCents(q.shippingCents, state.region)}</dd>
        <dt>Tax</dt><dd data-testid="tax">${formatCents(q.taxCents, state.region)}</dd>
        <dt>Total</dt><dd data-testid="total"><strong>${formatCents(q.totalCents, state.region)}</strong></dd>
      </dl>
      <button type="button" data-testid="place-order" ${q.lines.length ? '' : 'disabled'}>Place order</button>
      <p class="muted" data-testid="order-placed" hidden>Order placed. Thank you!</p>
    </section>`
}

function render() {
  const route = currentRoute()
  for (const a of navLinks)
    a.classList.toggle(
      'active',
      a.getAttribute('href') === (route === 'catalog' ? '#/' : `#/${route}`),
    )
  document.getElementById('cart-count').textContent = String(itemCount())
  app.innerHTML =
    route === 'cart' ? renderCart() : route === 'checkout' ? renderCheckout() : renderCatalog()
}

app.addEventListener('click', (e) => {
  const t = e.target
  if (!(t instanceof HTMLElement)) return
  if (t.dataset.add)
    update({ lines: normalizeLines([...state.lines, { sku: t.dataset.add, qty: 1 }]) })
  if (t.dataset.remove) update({ lines: state.lines.filter((l) => l.sku !== t.dataset.remove) })
  if (t.dataset.testid === 'apply-coupon')
    update({ coupon: app.querySelector('[data-testid="coupon-input"]').value.trim().toUpperCase() })
  if (t.dataset.testid === 'place-order') {
    update({ lines: [], coupon: '' })
    app.querySelector('[data-testid="order-placed"]').hidden = false
  }
})

app.addEventListener('change', (e) => {
  const t = e.target
  if (t instanceof HTMLInputElement && t.dataset.qty) {
    update({
      lines: state.lines.map((l) =>
        l.sku === t.dataset.qty ? { ...l, qty: clampQty(t.value) } : l,
      ),
    })
  }
  if (t instanceof HTMLSelectElement && t.dataset.testid === 'region-select')
    update({ region: t.value })
})

window.addEventListener('hashchange', render)
render()
