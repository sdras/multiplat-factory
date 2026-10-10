# ios-objc-notes

The Objective-C twin of `ios-uikit-notes`: the same two-screen UIKit notes app (list with search,
add, swipe to delete; editor with title, body, save, delete) written in Objective-C with an XcodeGen
`project.yml` instead of a checked-in `.xcodeproj`. Public UIKit samples in Objective-C are mostly
unlicensed or stale, which is why this one is in-house.

- notes persisted in `NSUserDefaults` under `notes.v1` as a JSON array of
  `{ "id": UUID, "title", "body", "updatedAt": ISO-8601 }`, newest first
- the logic lives in `MPFNoteStore` (title fallback and 80-character cap, case-insensitive search,
  whitespace-collapsing excerpts, empty notes never saved) with an XCTest target the factory runs
  as the source's own suite
- `accessibilityIdentifier` on every interactive element (`add-note`, `search-notes`,
  `note-row-<index>`, `note-title`, `note-body`, `save-note`, `delete-note`, `empty-state`)

Apache-2.0 licensed, like the rest of this repository.
