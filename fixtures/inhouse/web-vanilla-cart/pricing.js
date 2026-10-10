// Pure pricing rules for the cart. No DOM, no time, no I/O: every function is a candidate for
// the shared core, and every rule below is the kind that must not drift between platforms.

/** Catalog with integer cents so no float slips into the wire format. */
export const CATALOG = [
  { sku: 'MUG-01', name: 'Enamel mug', priceCents: 1400, category: 'kitchen', weightGrams: 320 },
  {
    sku: 'TEA-02',
    name: 'Loose-leaf tea, 100 g',
    priceCents: 950,
    category: 'food',
    weightGrams: 120,
  },
  { sku: 'POT-03', name: 'Teapot, 1 l', priceCents: 4200, category: 'kitchen', weightGrams: 900 },
  { sku: 'BOK-04', name: 'Field notebook', priceCents: 700, category: 'paper', weightGrams: 150 },
  { sku: 'PEN-05', name: 'Fountain pen', priceCents: 2600, category: 'paper', weightGrams: 40 },
]

export const REGIONS = {
  US: {
    label: 'United States',
    taxRate: 0.0725,
    freeShippingCents: 5000,
    shippingBaseCents: 599,
    shippingPerKgCents: 150,
  },
  EU: {
    label: 'European Union',
    taxRate: 0.2,
    freeShippingCents: 6000,
    shippingBaseCents: 899,
    shippingPerKgCents: 200,
  },
  JP: {
    label: 'Japan',
    taxRate: 0.1,
    freeShippingCents: 8000,
    shippingBaseCents: 1200,
    shippingPerKgCents: 300,
  },
}

/** Coupons: percent or fixed, optional category and minimum subtotal. */
export const COUPONS = {
  TEATIME: { kind: 'percent', value: 15, category: 'food' },
  WELCOME5: { kind: 'fixed', valueCents: 500, minSubtotalCents: 2000 },
  BIGPOT: { kind: 'percent', value: 10, minSubtotalCents: 4000 },
}

export const MAX_QTY = 20

/** Round half away from zero in cents (what the source's receipts do; JS Math.round would round -0.5 to -0). */
export function roundCents(value) {
  return value < 0 ? -Math.round(-value) : Math.round(value)
}

export function clampQty(qty) {
  const n = Number(qty)
  if (!Number.isFinite(n)) return 1
  return Math.min(MAX_QTY, Math.max(1, Math.trunc(n)))
}

/** Lines are { sku, qty }; unknown skus are ignored, quantities are clamped. */
export function normalizeLines(lines) {
  const seen = new Map()
  for (const line of Array.isArray(lines) ? lines : []) {
    const item = CATALOG.find((c) => c.sku === line?.sku)
    if (!item) continue
    seen.set(item.sku, clampQty((seen.get(item.sku) ?? 0) + clampQty(line.qty)))
  }
  return [...seen.entries()].map(([sku, qty]) => ({ sku, qty }))
}

export function subtotalCents(lines) {
  return normalizeLines(lines).reduce(
    (sum, l) => sum + CATALOG.find((c) => c.sku === l.sku).priceCents * l.qty,
    0,
  )
}

export function totalWeightGrams(lines) {
  return normalizeLines(lines).reduce(
    (sum, l) => sum + CATALOG.find((c) => c.sku === l.sku).weightGrams * l.qty,
    0,
  )
}

/** Volume tier: 3 or more of one sku takes 5% off that line; 10 or more takes 12%. */
export function volumeDiscountCents(lines) {
  let off = 0
  for (const l of normalizeLines(lines)) {
    const price = CATALOG.find((c) => c.sku === l.sku).priceCents * l.qty
    if (l.qty >= 10) off += roundCents(price * 0.12)
    else if (l.qty >= 3) off += roundCents(price * 0.05)
  }
  return off
}

/**
 * Coupon discount on the subtotal after volume discounts. Returns { cents, reason } where
 * reason explains a zero (unknown code, minimum not met, no eligible items).
 */
export function couponDiscount(lines, code) {
  const normalized = (code ?? '').trim().toUpperCase()
  if (!normalized) return { cents: 0, reason: 'none' }
  const coupon = COUPONS[normalized]
  if (!coupon) return { cents: 0, reason: 'unknown' }
  const base = subtotalCents(lines) - volumeDiscountCents(lines)
  if (coupon.minSubtotalCents && base < coupon.minSubtotalCents)
    return { cents: 0, reason: 'minimum' }
  if (coupon.kind === 'fixed')
    return { cents: Math.min(coupon.valueCents, base), reason: 'applied' }
  const eligible = normalizeLines(lines)
    .map((l) => ({ item: CATALOG.find((c) => c.sku === l.sku), qty: l.qty }))
    .filter(({ item }) => !coupon.category || item.category === coupon.category)
    .reduce((sum, { item, qty }) => sum + item.priceCents * qty, 0)
  if (eligible === 0) return { cents: 0, reason: 'ineligible' }
  return { cents: roundCents(eligible * (coupon.value / 100)), reason: 'applied' }
}

export function shippingCents(lines, regionCode) {
  const region = REGIONS[regionCode] ?? REGIONS.US
  const lineCount = normalizeLines(lines).length
  if (lineCount === 0) return 0
  const goods = subtotalCents(lines) - volumeDiscountCents(lines)
  if (goods >= region.freeShippingCents) return 0
  const kg = Math.ceil(totalWeightGrams(lines) / 1000)
  return region.shippingBaseCents + region.shippingPerKgCents * Math.max(0, kg - 1)
}

/** Tax applies to goods after discounts, never to shipping. */
export function taxCents(lines, regionCode, couponCode) {
  const region = REGIONS[regionCode] ?? REGIONS.US
  const goods =
    subtotalCents(lines) - volumeDiscountCents(lines) - couponDiscount(lines, couponCode).cents
  return roundCents(Math.max(0, goods) * region.taxRate)
}

/** The whole receipt as integers; this object is what the checkout screen renders. */
export function quote(lines, regionCode = 'US', couponCode = '') {
  const normalized = normalizeLines(lines)
  const subtotal = subtotalCents(normalized)
  const volume = volumeDiscountCents(normalized)
  const coupon = couponDiscount(normalized, couponCode)
  const shipping = shippingCents(normalized, regionCode)
  const tax = taxCents(normalized, regionCode, couponCode)
  const total = Math.max(0, subtotal - volume - coupon.cents) + shipping + tax
  return {
    lines: normalized.map((l) => {
      const item = CATALOG.find((c) => c.sku === l.sku)
      return {
        sku: l.sku,
        name: item.name,
        qty: l.qty,
        unitCents: item.priceCents,
        lineCents: item.priceCents * l.qty,
      }
    }),
    subtotalCents: subtotal,
    volumeDiscountCents: volume,
    couponCode: couponCode.trim().toUpperCase(),
    couponCents: coupon.cents,
    couponReason: coupon.reason,
    shippingCents: shipping,
    taxCents: tax,
    totalCents: total,
    region: REGIONS[regionCode] ? regionCode : 'US',
  }
}

/** "$12.34"; the receipt never shows more or fewer than two decimals. */
export function formatCents(cents, regionCode = 'US') {
  const symbol = regionCode === 'EU' ? '€' : regionCode === 'JP' ? '¥' : '$'
  const abs = Math.abs(cents)
  const whole = Math.floor(abs / 100)
  const frac = String(abs % 100).padStart(2, '0')
  return `${cents < 0 ? '-' : ''}${symbol}${whole.toLocaleString('en-US')}.${frac}`
}
