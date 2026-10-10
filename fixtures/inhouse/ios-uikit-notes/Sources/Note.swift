import Foundation

struct Note: Codable, Equatable, Identifiable {
    var id: UUID
    var title: String
    var body: String
    var updatedAt: Date
}
