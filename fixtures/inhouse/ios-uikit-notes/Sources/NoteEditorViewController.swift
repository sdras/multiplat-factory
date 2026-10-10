import UIKit

/// New or existing note: title, body, save; delete only for an existing note. An empty note is never saved.
final class NoteEditorViewController: UIViewController {
    private let store: NoteStore
    private let noteId: UUID?
    private let titleField = UITextField()
    private let bodyView = UITextView()

    init(store: NoteStore, noteId: UUID?) {
        self.store = store
        self.noteId = noteId
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        title = noteId == nil ? "New note" : "Edit note"
        navigationItem.largeTitleDisplayMode = .never

        let save = UIBarButtonItem(title: "Save", style: .done, target: self, action: #selector(saveTapped))
        save.accessibilityIdentifier = "save-note"
        navigationItem.rightBarButtonItem = save

        titleField.placeholder = "Title"
        titleField.font = .preferredFont(forTextStyle: .title2)
        titleField.borderStyle = .roundedRect
        titleField.accessibilityIdentifier = "note-title"

        bodyView.font = .preferredFont(forTextStyle: .body)
        bodyView.layer.borderColor = UIColor.separator.cgColor
        bodyView.layer.borderWidth = 1
        bodyView.layer.cornerRadius = 8
        bodyView.accessibilityIdentifier = "note-body"

        let stack = UIStackView(arrangedSubviews: [titleField, bodyView])
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16),
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
            bodyView.heightAnchor.constraint(equalToConstant: 240),
        ])

        if let id = noteId, let note = store.note(id: id) {
            titleField.text = note.title
            bodyView.text = note.body
            let delete = UIButton(type: .system)
            delete.setTitle("Delete note", for: .normal)
            delete.setTitleColor(.systemRed, for: .normal)
            delete.accessibilityIdentifier = "delete-note"
            delete.addTarget(self, action: #selector(deleteTapped), for: .touchUpInside)
            stack.addArrangedSubview(delete)
        }
    }

    @objc private func saveTapped() {
        let title = titleField.text ?? ""
        let body = bodyView.text ?? ""
        let blank = title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if !blank {
            if let id = noteId {
                store.update(id: id, title: title, body: body)
            } else {
                store.add(title: title, body: body)
            }
        }
        navigationController?.popViewController(animated: true)
    }

    @objc private func deleteTapped() {
        guard let id = noteId else { return }
        store.delete(id: id)
        navigationController?.popViewController(animated: true)
    }
}
