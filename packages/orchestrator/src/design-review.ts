import { DesignReply } from '@mpf/core'

export const DESIGN_REVIEW_PROMPT = `Begin a design review with exactly three distinct visual options, IDs a, b, c. Use the supplied app specification, plan, source screenshots, and user preferences. Read relevant screenshots before deciding. Each option must preserve the app's real functions and use concrete app-specific navigation, sample content, and action labels. Do not replace an app with a marketing landing page. Use sidebar, topbar, and split once each: three different information hierarchies, not color swaps. For mobile targets describe how navigation and content adapt to a narrow screen. Explain each option's benefit and one honest tradeoff in plain language. The mockup is a small conceptual screen rendered from structured data, not a built app or a screenshot of completed work. Use high-contrast six-digit hex palettes, readable typography, and restrained styling. Put implementation guidance in instructions, preserving existing behavior. Return only text and the three options. Do not select an option or propose a build; the user chooses first. Never claim to have inspected files that are unavailable. If app evidence is absent, clearly label the options as preliminary.`

/** Deterministic, visibly labeled demo data; real projects always use their model and app context. */
export function demoDesignReply() {
  const common = {
    appName: 'Tasks',
    title: 'Your tasks',
    subtitle: 'Keep track of what needs doing.',
    navigation: ['All tasks', 'Active', 'Completed'],
    action: 'Add task',
    items: [
      { title: 'Review the new layout', detail: 'Today · Design' },
      { title: 'Test on a smaller screen', detail: 'Today · Testing' },
      { title: 'Prepare the next release', detail: 'Tomorrow · Release' },
    ],
  }
  return DesignReply.parse({
    text: 'Three example directions for the demo task app. These are concept mockups; no model was called and no app was changed.',
    options: [
      {
        id: 'a',
        name: 'Everything within reach',
        summary: 'Filters stay in a sidebar, with a clear task list beside them.',
        tradeoff: 'Fast to navigate on desktop; the sidebar collapses on smaller screens.',
        instructions:
          'Use persistent sidebar filters on desktop and a compact filter control on mobile. Preserve task creation, completion, deletion, filtering and persistence.',
        mockup: {
          ...common,
          layout: 'sidebar',
          typography: 'sans',
          corners: 'soft',
          palette: { background: '#f3f5f2', surface: '#ffffff', ink: '#243d32', accent: '#35664f' },
        },
      },
      {
        id: 'b',
        name: 'A quieter list',
        summary: 'A wide, focused list with filters above it and very little decoration.',
        tradeoff: 'More room for task names, but less space for secondary information.',
        instructions:
          'Use horizontal filters above a focused task list. Keep strong typography, generous row spacing and all existing task behaviors.',
        mockup: {
          ...common,
          layout: 'topbar',
          typography: 'serif',
          corners: 'square',
          palette: { background: '#f7f3ec', surface: '#fffdf8', ink: '#382e27', accent: '#995039' },
        },
      },
      {
        id: 'c',
        name: 'Focus on one task',
        summary: 'The list and the selected task sit side by side for quick review.',
        tradeoff: 'Useful for reviewing details; on mobile, details open as a separate view.',
        instructions:
          'Use a list-detail layout, showing only information the source app supports. On mobile navigate between list and detail. Preserve all task behaviors; do not invent new features.',
        mockup: {
          ...common,
          layout: 'split',
          typography: 'sans',
          corners: 'round',
          palette: { background: '#edf1fa', surface: '#ffffff', ink: '#252e49', accent: '#4b59a5' },
        },
      },
    ],
  })
}
