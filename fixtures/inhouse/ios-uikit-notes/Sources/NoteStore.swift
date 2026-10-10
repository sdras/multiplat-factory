import Foundation

/// Notes live in UserDefaults as a JSON array under `notes.v1`, newest first:
/// `[{ "id": UUID string, "title": String, "body": String, "updatedAt": ISO-8601 }]`.
final class NoteStore {
    static let storageKey = "notes.v1"
    static let titleLimit = 80

    private let defaults: UserDefaults
    private(set) var notes: [Note] = []

    init(defaults: UserDefaults) {
        self.defaults = defaults
        load()
    }

    var isEmpty: Bool { notes.isEmpty }

    @discardableResult
    func add(title: String, body: String, now: Date = Date()) -> Note {
        let note = Note(id: UUID(), title: NoteStore.normalizedTitle(title, body: body), body: body, updatedAt: now)
        notes.insert(note, at: 0)
        save()
        return note
    }

    func update(id: UUID, title: String, body: String, now: Date = Date()) {
        guard let index = notes.firstIndex(where: { $0.id == id }) else { return }
        var note = notes[index]
        note.title = NoteStore.normalizedTitle(title, body: body)
        note.body = body
        note.updatedAt = now
        notes.remove(at: index)
        notes.insert(note, at: 0)
        save()
    }

    func delete(id: UUID) {
        notes.removeAll { $0.id == id }
        save()
    }

    func note(id: UUID) -> Note? {
        notes.first { $0.id == id }
    }

    /// Case-insensitive match on title or body; an empty query returns everything.
    func filtered(query: String) -> [Note] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return notes }
        return notes.filter { $0.title.lowercased().contains(q) || $0.body.lowercased().contains(q) }
    }

    /// An empty title falls back to the first non-empty line of the body, then to "Untitled"; titles are capped at 80 characters.
    static func normalizedTitle(_ title: String, body: String) -> String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let firstLine = body.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty } ?? ""
        let candidate = trimmed.isEmpty ? firstLine : trimmed
        if candidate.isEmpty { return "Untitled" }
        return String(candidate.prefix(titleLimit))
    }

    /// One-line preview: whitespace collapsed, cut at `limit` characters with an ellipsis.
    static func excerpt(_ body: String, limit: Int = 60) -> String {
        let collapsed = body.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        if collapsed.count <= limit { return collapsed }
        return String(collapsed.prefix(limit)).trimmingCharacters(in: .whitespaces) + "…"
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

    private func load() {
        guard let data = defaults.data(forKey: NoteStore.storageKey),
              let decoded = try? NoteStore.decoder.decode([Note].self, from: data) else { return }
        notes = decoded.sorted { $0.updatedAt > $1.updatedAt }
    }

    private func save() {
        if let data = try? NoteStore.encoder.encode(notes) {
            defaults.set(data, forKey: NoteStore.storageKey)
        }
    }
}
