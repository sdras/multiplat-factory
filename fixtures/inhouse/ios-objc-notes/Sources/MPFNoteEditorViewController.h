@import UIKit;

@class MPFNoteStore;

/// New or existing note: title, body, save; delete only for an existing note. An empty note is never saved.
@interface MPFNoteEditorViewController : UIViewController
- (instancetype)initWithStore:(MPFNoteStore *)store noteIdentifier:(nullable NSString *)noteIdentifier;
@end
