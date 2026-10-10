import { createConfigForNuxt } from '@nuxt/eslint-config/flat'

export default createConfigForNuxt({
  features: { tooling: true, stylistic: false },
})
  .append({
    ignores: [
      '**/dist/**',
      '**/.output/**',
      '**/.nuxt/**',
      '**/node_modules/**',
      'fixtures/.cache/**',
    ],
  })
  .append({
    // Nuxt pages and layouts are file-routed; single-word names are the convention there.
    files: [
      'apps/dashboard/app/pages/**/*.vue',
      'apps/dashboard/app/layouts/**/*.vue',
      'apps/dashboard/app/app.vue',
    ],
    rules: { 'vue/multi-word-component-names': 'off' },
  })
  .append({
    rules: {
      'vue/html-self-closing': 'off',
      // Plain capturing groups in scanning regexes are clearer than (?:) noise everywhere.
      'regexp/no-unused-capturing-group': 'off',
      // Explicit ASCII classes document identifier rules better than \w, \d, or an i flag.
      'regexp/prefer-w': 'off',
      // Prettier prints hex digits in lowercase; the formatter wins.
      'unicorn/number-literal-case': 'off',
      'regexp/prefer-d': 'off',
      'regexp/use-ignore-case': 'off',
    },
  })
  .append({
    // Playwright Locator.innerText() is not a DOM property; the unicorn rule misfires here.
    files: [
      'packages/analyzer/src/observe/**/*.ts',
      'packages/adapters/src/target/web/executor.ts',
    ],
    rules: { 'unicorn/prefer-dom-node-text-content': 'off' },
  })
  .append({
    // Target adapters parse bounded compiler and test-runner output line by line: ANSI escapes are
    // stripped on purpose, and the backtracking rule's worst cases cannot occur on single lines.
    files: ['packages/adapters/src/target/**/*.ts'],
    rules: {
      'no-control-regex': 'off',
      'unicorn/escape-case': 'off',
      'regexp/no-super-linear-backtracking': 'off',
      'regexp/no-useless-lazy': 'off',
    },
  })
