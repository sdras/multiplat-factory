import XCTest
@testable import UIKitNotes

final class NoteStoreTests: XCTestCase {
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: "NoteStoreTests")
        defaults.removePersistentDomain(forName: "NoteStoreTests")
    }

    func testAddPutsNewestFirstAndPersists() {
        let store = NoteStore(defaults: defaults)
        store.add(title: "First", body: "a", now: Date(timeIntervalSince1970: 1))
        store.add(title: "Second", body: "b", now: Date(timeIntervalSince1970: 2))
        XCTAssertEqual(store.notes.map(\.title), ["Second", "First"])
        let reloaded = NoteStore(defaults: defaults)
        XCTAssertEqual(reloaded.notes, store.notes)
    }

    func testTitleFallsBackToFirstBodyLine() {
        XCTAssertEqual(NoteStore.normalizedTitle("  ", body: "Buy milk\nand eggs"), "Buy milk")
        XCTAssertEqual(NoteStore.normalizedTitle("", body: ""), "Untitled")
        XCTAssertEqual(NoteStore.normalizedTitle(String(repeating: "x", count: 100), body: "").count, 80)
    }

    func testSearchIsCaseInsensitiveOnTitleAndBody() {
        let store = NoteStore(defaults: defaults)
        store.add(title: "Groceries", body: "Milk and eggs")
        store.add(title: "Ideas", body: "A note app")
        XCTAssertEqual(store.filtered(query: "MILK").map(\.title), ["Groceries"])
        XCTAssertEqual(store.filtered(query: "note").map(\.title), ["Ideas"])
        XCTAssertEqual(store.filtered(query: "  ").count, 2)
    }

    func testExcerptCollapsesWhitespaceAndCuts() {
        XCTAssertEqual(NoteStore.excerpt("a  b\n\nc"), "a b c")
        XCTAssertEqual(NoteStore.excerpt("word word word word", limit: 10), "word word…")
    }

    func testDeleteRemovesAndPersists() {
        let store = NoteStore(defaults: defaults)
        let note = store.add(title: "Gone", body: "")
        store.delete(id: note.id)
        XCTAssertTrue(store.isEmpty)
        XCTAssertTrue(NoteStore(defaults: defaults).isEmpty)
    }
}
