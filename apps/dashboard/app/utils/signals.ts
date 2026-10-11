/**
 * Signals the factory writes into free text (log lines, case messages). Recognized here so the
 * pages can give them a shape; the reducer handles the ones that need to survive transcript trimming.
 */

/** A device notice: what the harness dismissed on the emulator or simulator before launching an app. */
export function isDeviceNotice(text: string): boolean {
  return text.startsWith('before launching')
}

const DIALOG_LINE = 'A system dialog covers the app:'

/**
 * The evidence summary leads with a dialog line when a system dialog hid the app under test.
 * Returns that line on its own and the rest of the message unchanged.
 */
export function splitDialogLine(message?: string): { dialog?: string; rest: string } {
  if (!message) return { rest: '' }
  const lines = message.split('\n')
  const i = lines.findIndex((l) => l.startsWith(DIALOG_LINE))
  if (i === -1) return { rest: message }
  return { dialog: lines[i], rest: lines.filter((_, j) => j !== i).join('\n') }
}

/**
 * A pause reason is one paragraph: what happened, then what the choices do ("Continue to …, or
 * reject to cancel."). Split before the sentence that names the choices so it can sit on its own line.
 */
export function reasonLines(reason: string): string[] {
  const parts = reason.split('. ')
  const i = parts.findIndex((p) => /\breject\b/.test(p))
  if (i <= 0) return [reason]
  return [`${parts.slice(0, i).join('. ')}.`, parts.slice(i).join('. ')]
}
