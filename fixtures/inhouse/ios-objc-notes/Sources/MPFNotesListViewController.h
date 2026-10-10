@import UIKit;

@class MPFNoteStore;

/// The list screen: search, add, open a note, swipe to delete.
@interface MPFNotesListViewController : UITableViewController
- (instancetype)initWithStore:(MPFNoteStore *)store;
@end
