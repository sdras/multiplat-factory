import type { AppSpec, CoreFunction, Platform, PortPlan } from '@mpf/core'

/**
 * How a worker runs the source's pure logic on each platform so its vectors can carry `executed`
 * provenance. Platform knowledge only, no framework names; the stage's bash allowlist
 * (`logicRunnerAllow` in the adapters) admits exactly these commands.
 */
export function executedVectorsGuidance(platform: Platform, language?: string): string {
  if (platform === 'ios' && /objective-?c/i.test(language ?? '')) {
    return [
      'Executed vectors: no script can import the app, so build a throwaway harness. The Toolchain section says where Xcode is. Copy the Foundation-only `.h`/`.m` files (the model and store classes, never a view controller or anything that imports UIKit) into a scratch folder named `mpf-harness/` directly under your working directory (your cwd is the one place you may write; the core crate directory and any `harness/` folder another worker left there are read-only reference), add a `main.m` that calls each function with every vector input and prints one JSON line per vector, compile with `xcrun clang -fobjc-arc -framework Foundation mpf-harness/*.m -o mpf-harness/run`, run `./mpf-harness/run`, and record what it prints as "executed"; never look for a toolchain yourself.',
      'Files that import UIKit stay out: keep their vectors "derived" and say so in the note.',
      '`node` is available for glue scripts that read or write vector JSON; it never makes a vector "executed", only the harness built from the source files does.',
    ].join(' ')
  }
  switch (platform) {
    case 'web':
      return 'Executed vectors: run the pure modules with `node` (or `npx tsx` for TypeScript), importing them from the read-only source directory, and record the outputs they actually produce as "executed".'
    case 'ios':
      return [
        'Executed vectors: no script can import the app, so build a throwaway harness. The Toolchain section says where Xcode is: `swiftc -o mpf-harness/run <files>` (or `xcrun swiftc`) then run the binary; never look for a toolchain yourself. Copy the pure logic files into a scratch folder named `mpf-harness/` directly under your working directory (your cwd is the one place you may write; the core crate directory and any `harness/` folder another worker left there are read-only reference), add a `main.swift` that calls each function with every vector input and prints one JSON line per vector, compile with `swiftc -o harness <files> main.swift` (or `xcrun swiftc`), run `./harness`, and record what it prints as "executed".',
        'The harness must not import UIKit or SwiftUI: leave files that depend on them out, keep their vectors "derived", and say so in the note.',
        '`node` is available for glue scripts that read or write vector JSON; it never makes a vector "executed", only the harness built from the source files does.',
      ].join(' ')
    case 'android':
      return [
        'Executed vectors: no script can import the app, so build a throwaway harness. The Toolchain section says where the JDK is: `javac -cp <jars> -d mpf-harness/out <files>` then `java -cp <jars>:mpf-harness/out Harness`, with third-party jars from the Gradle cache it names; never look for a JDK yourself. Copy the pure logic files into a scratch folder named `mpf-harness/` directly under your working directory (your cwd is the one place you may write; the core crate directory and any `harness/` folder another worker left there are read-only reference), add a `Main.kt` (or `Main.java`) that calls each function with every vector input and prints one JSON line per vector, compile with `kotlinc <files> Main.kt -include-runtime -d harness.jar` and run `java -jar harness.jar` (or `javac -d out <files> Main.java` and `java -cp out Main`), and record what it prints as "executed".',
        'The harness must not import `android.*` or `androidx.*`: leave files that depend on them out, keep their vectors "derived", and say so in the note.',
        '`node` is available for glue scripts that read or write vector JSON; it never makes a vector "executed", only the harness built from the source files does.',
      ].join(' ')
  }
}

export const CORE_EXTRACT_SYSTEM = `You are the core-extraction worker inside multiplat-factory, a tool that ports apps between web, iOS, and Android.
You port the platform-independent logic of an app into a Rust crate that compiles to one WebAssembly module used by every target. The crate in the current directory already builds and exposes the ABI; you fill in the functions.

Rules:
- Implement every function listed in manifest.json inside src/api/<name>.rs. Keep api::dispatch routing every name. Do not touch src/lib.rs.
- Each function takes one JSON object and returns one JSON value. Validate input and return CoreError::invalid_input on bad data; never panic and never unwrap on user data.
- The core is deterministic and has no imports: no clock, randomness, locale, environment, file, or network access. Model time, locale, and randomness as explicit inputs when the source needs them.
- Match the source app's behavior exactly, including edge cases, rounding, and the byte-level wire formats it persists or sends. Read the source whenever the spec is ambiguous.
- Keep manifest.json accurate: field names and types in inputSchema/outputSchema must match what your Rust types accept and produce (serde field names). Host bindings are generated from it.
- Add vectors to vectors/<function>.json for every edge case you find in the source; they are the acceptance tests on every host. When the source's pure logic can be executed with the interpreter you are allowed (for example \`node\` on a JavaScript source, importing the source module from its read-only directory), record the outputs it actually produces and mark those vectors provenance "executed"; vectors you derived by reading are "derived". Keep existing vectors unless they contradict the source, and say so in your notes if you change one.
- Run \`cargo build --release --target wasm32-unknown-unknown\` and \`cargo test\` until both are green.
- Finish with the structured output: functions implemented, files written, vectors added, and notes for the reviewer (including anything you could not port and why).`

export const CoreExtractResultShape = {
  functions: 'string[]',
  filesWritten: 'string[]',
  vectorsAdded: 'number',
  notes: 'string',
} as const

export interface CoreExtractPromptInput {
  spec: AppSpec
  plan: PortPlan
  sourceDir: string
  instructions: string[]
  /** The crate already holds a previous attempt's work; continue rather than restart. */
  resuming?: boolean
}

export function coreExtractPrompt(i: CoreExtractPromptInput): string {
  const logic = i.spec.logic.filter((l) => l.purity === 'pure')
  return [
    `Source app (read-only): ${i.sourceDir}`,
    i.resuming
      ? 'The crate in the current directory already holds a previous attempt (some functions and vectors may be done, and it may not build yet). Read it first and continue from it; do not start over.'
      : `The crate in the current directory is the scaffold; it builds as is and answers "unimplemented" for every function.`,
    '',
    'Functions to implement (from the port plan):',
    '```json',
    JSON.stringify(i.plan.core.functions, null, 1).slice(0, 30_000),
    '```',
    '',
    'Pure logic units the analyzer found in the source (file, symbol, description):',
    ...logic.map((l) => `- ${l.file} ${l.symbol} (${l.loc} lines): ${l.description}`),
    '',
    executedVectorsGuidance(i.spec.source.platform, i.spec.source.language),
    '',
    'AppSpec state and persistence (wire formats to keep):',
    '```json',
    JSON.stringify(i.spec.state, null, 1).slice(0, 20_000),
    '```',
    '',
    'Implement the functions now. Build for wasm32 and run cargo test until green, then return the structured output.',
    ...(i.instructions.length
      ? ['', 'Additional instructions from the operator:', ...i.instructions.map((x) => `- ${x}`)]
      : []),
  ].join('\n')
}

export const VECTORS_SYSTEM = `You are the golden-vector worker inside multiplat-factory. You read an app's source and write test vectors for the logic that a shared core must reproduce: concrete inputs and the exact outputs the source produces for them.

Rules:
- For every function, write 6 to 15 vectors: the happy path, boundaries (empty, zero, negative, maximum), rounding and formatting edges, and any invariant the source enforces. Prefer cases you can trace precisely through the source; state the file and line you traced in the note.
- Inputs must match the function's inputSchema and expected values its outputSchema exactly (field names, types, number formats).
- Mark a vector "executed" only when you ran the source's own logic with the interpreter you are allowed (for example \`node\` importing the source module) and copied its actual output; otherwise mark it "derived". Prefer executed vectors wherever the source can be run.
- Never invent behavior. If the source is ambiguous for a case, leave that case out and mention it in notes.
- Return only the structured output.`

export interface VectorsPromptInput {
  functions: CoreFunction[]
  spec: AppSpec
  sourceDir: string
  instructions: string[]
}

export function vectorsPrompt(i: VectorsPromptInput): string {
  return [
    `Source app (read-only): ${i.sourceDir}`,
    '',
    'Functions and their schemas:',
    '```json',
    JSON.stringify(i.functions, null, 1).slice(0, 30_000),
    '```',
    '',
    'Pure logic units the analyzer found (file, symbol):',
    ...i.spec.logic
      .filter((l) => l.purity === 'pure')
      .map((l) => `- ${l.file} ${l.symbol}: ${l.description}`),
    '',
    executedVectorsGuidance(i.spec.source.platform, i.spec.source.language),
    '',
    'Write the vector sets now.',
    ...(i.instructions.length
      ? ['', 'Additional instructions from the operator:', ...i.instructions.map((x) => `- ${x}`)]
      : []),
  ].join('\n')
}

export function coreFixPrompt(
  kind: 'build' | 'vectors',
  detail: string[],
  round: number,
  max: number,
): string {
  return [
    kind === 'build'
      ? `The wasm build failed (fix round ${round} of ${max}). Fix the causes below, rebuild for wasm32, keep cargo test green, and return the structured output again.`
      : `Golden vectors failed under cargo test (fix round ${round} of ${max}). The source app is the reference: fix the implementation, or correct a vector only when you can show from the source that the vector was wrong (say so in notes). Then return the structured output again.`,
    '',
    ...detail.slice(0, 60).map((d) => `- ${d}`),
  ].join('\n')
}
