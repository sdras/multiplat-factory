# android-views-java-notes

An in-house Android fixture written in Java with XML layouts (no Kotlin, no Compose) and a plain
Gradle build without a checked-in wrapper (the factory uses `./gradlew` when present, else `gradle`):

- two activities: the notes list (`MainActivity`: search, add, open) and the editor
  (`NoteEditorActivity`: title, body, save; delete for an existing note)
- notes persisted in `SharedPreferences` under `notes.v1` as a JSON array of
  `{ "id": uuid, "title", "body", "updatedAt": epoch millis }`, newest first
- the logic in `NoteStore` is pure Java behind a tiny `Storage` interface (title fallback and
  80-character cap, case-insensitive search, whitespace-collapsing excerpts, empty notes never
  saved), with a JUnit 4 suite the factory runs as the source's own tests
- stable `android:id`s on every interactive element (`search_notes`, `add_note`, `notes_list`,
  `empty_state`, `note_title`, `note_body`, `save_note`, `delete_note`) for Maestro

Public Views + Java samples are stale or unlicensed, which is why this one is in-house.
Apache-2.0 licensed, like the rest of this repository.
