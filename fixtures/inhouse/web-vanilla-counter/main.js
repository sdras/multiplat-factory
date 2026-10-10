// A deliberately small app with two screens, persisted state, and a little logic.
// It exists to exercise the factory: detection, inventory, spec, behaviors, observation.

const STORAGE_KEY = 'counter.state'
const DEFAULTS = { count: 0, step: 1 }

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw)
    return {
      count: clampCount(Number(parsed.count) || 0),
      step: clampStep(Number(parsed.step) || 1),
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

/** Count never goes below zero. */
export function clampCount(n) {
  return Math.max(0, Math.round(n))
}

/** Step is an integer between 1 and 10. */
export function clampStep(n) {
  return Math.min(10, Math.max(1, Math.round(n)))
}

export function increment(state) {
  return { ...state, count: clampCount(state.count + state.step) }
}

export function decrement(state) {
  return { ...state, count: clampCount(state.count - state.step) }
}

export function reset(state) {
  return { ...state, count: 0 }
}

export function parity(count) {
  return count % 2 === 0 ? 'even' : 'odd'
}

let state = loadState()
const app = document.getElementById('app')

function update(next) {
  state = next
  saveState(state)
  render()
}

function renderCounter() {
  app.innerHTML = `
    <section data-testid="screen-counter">
      <p class="value" data-testid="count-value">${state.count}</p>
      <p class="hint" data-testid="count-parity">${parity(state.count)}</p>
      <div class="actions">
        <button data-testid="decrement">−${state.step}</button>
        <button data-testid="increment">+${state.step}</button>
        <button data-testid="reset" class="secondary">Reset</button>
      </div>
    </section>`
  app
    .querySelector('[data-testid="increment"]')
    .addEventListener('click', () => update(increment(state)))
  app
    .querySelector('[data-testid="decrement"]')
    .addEventListener('click', () => update(decrement(state)))
  app.querySelector('[data-testid="reset"]').addEventListener('click', () => update(reset(state)))
}

function renderSettings() {
  app.innerHTML = `
    <section data-testid="screen-settings">
      <label for="step">Step size (1–10)</label>
      <input id="step" type="number" min="1" max="10" value="${state.step}" data-testid="step-input" />
      <button data-testid="save-step">Save</button>
      <p class="hint" data-testid="step-saved" hidden>Saved</p>
    </section>`
  app.querySelector('[data-testid="save-step"]').addEventListener('click', () => {
    const input = app.querySelector('[data-testid="step-input"]')
    update({ ...state, step: clampStep(Number(input.value)) })
    input.value = String(state.step)
    app.querySelector('[data-testid="step-saved"]').hidden = false
  })
}

function render() {
  const route = location.hash.replace(/^#/, '') || '/'
  for (const a of document.querySelectorAll('nav a')) {
    a.classList.toggle('active', a.getAttribute('href') === `#${route}`)
  }
  if (route === '/settings') renderSettings()
  else renderCounter()
}

window.addEventListener('hashchange', render)
render()
