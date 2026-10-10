// The Playwright behavior executor lives with the web target adapter so the observe stage
// (source apps) and the web target's end-to-end tests share one implementation.
export {
  executeBehavior,
  launchChromium,
  looseText,
  resolveElement,
  routeUrl,
  screenshotScreens,
  type Log,
  type StepResult,
} from '@mpf/adapters'
