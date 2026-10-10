# ios-uikit-notes

An in-house iOS fixture written with UIKit in Swift, no storyboards, and an XcodeGen `project.yml`
instead of a checked-in `.xcodeproj` (the factory generates the project on first use):

- two screens under a `UINavigationController`: the notes list (search, add, swipe to delete) and the
  note editor (title, body, save; delete for an existing note)
- notes persisted in `UserDefaults` under `notes.v1` as a JSON array of
  `{ "id": UUID, "title", "body", "updatedAt": ISO-8601 }`, newest first
- logic worth porting and testing in `NoteStore`: title fallback to the first body line then
  "Untitled", 80-character title cap, case-insensitive search, whitespace-collapsing excerpts, and
  the rule that an empty note is never saved
- an XCTest target (`UIKitNotesTests`) the factory runs as the source's own suite

Every interactive element carries an `accessibilityIdentifier` (`add-note`, `search-notes`,
`note-row-<index>`, `note-title`, `note-body`, `save-note`, `delete-note`, `empty-state`) so
behaviors can be verified on the source with Maestro.

Apache-2.0 licensed, like the rest of this repository.
