import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        let store = NoteStore(defaults: .standard)
        window.rootViewController = UINavigationController(rootViewController: NotesListViewController(store: store))
        window.makeKeyAndVisible()
        self.window = window
    }
}
