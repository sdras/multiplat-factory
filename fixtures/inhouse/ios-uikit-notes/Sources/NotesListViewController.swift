import UIKit

/// The list screen: search, add, open a note, swipe to delete.
final class NotesListViewController: UITableViewController, UISearchResultsUpdating {
    private let store: NoteStore
    private var shown: [Note] = []
    private let search = UISearchController(searchResultsController: nil)
    private let emptyLabel = UILabel()

    init(store: NoteStore) {
        self.store = store
        super.init(style: .insetGrouped)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Notes"
        navigationController?.navigationBar.prefersLargeTitles = true
        tableView.accessibilityIdentifier = "notes-list"
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "note")

        let add = UIBarButtonItem(barButtonSystemItem: .add, target: self, action: #selector(addTapped))
        add.accessibilityIdentifier = "add-note"
        navigationItem.rightBarButtonItem = add

        search.searchResultsUpdater = self
        search.obscuresBackgroundDuringPresentation = false
        search.searchBar.placeholder = "Search notes"
        search.searchBar.searchTextField.accessibilityIdentifier = "search-notes"
        navigationItem.searchController = search
        navigationItem.hidesSearchBarWhenScrolling = false

        emptyLabel.text = "No notes yet. Tap + to write one."
        emptyLabel.textAlignment = .center
        emptyLabel.textColor = .secondaryLabel
        emptyLabel.numberOfLines = 0
        emptyLabel.accessibilityIdentifier = "empty-state"
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        reload()
    }

    private func reload() {
        shown = store.filtered(query: search.searchBar.text ?? "")
        tableView.backgroundView = shown.isEmpty ? emptyLabel : nil
        tableView.reloadData()
    }

    func updateSearchResults(for searchController: UISearchController) {
        reload()
    }

    @objc private func addTapped() {
        navigationController?.pushViewController(NoteEditorViewController(store: store, noteId: nil), animated: true)
    }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        shown.count
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "note", for: indexPath)
        let note = shown[indexPath.row]
        var content = cell.defaultContentConfiguration()
        content.text = note.title
        content.secondaryText = NoteStore.excerpt(note.body)
        cell.contentConfiguration = content
        cell.accessoryType = .disclosureIndicator
        cell.accessibilityIdentifier = "note-row-\(indexPath.row)"
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let editor = NoteEditorViewController(store: store, noteId: shown[indexPath.row].id)
        navigationController?.pushViewController(editor, animated: true)
    }

    override func tableView(_ tableView: UITableView, commit editingStyle: UITableViewCell.EditingStyle, forRowAt indexPath: IndexPath) {
        guard editingStyle == .delete else { return }
        store.delete(id: shown[indexPath.row].id)
        reload()
    }
}
