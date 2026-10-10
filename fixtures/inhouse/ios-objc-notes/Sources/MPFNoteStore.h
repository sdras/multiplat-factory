@import Foundation;
#import "MPFNote.h"

NS_ASSUME_NONNULL_BEGIN

extern NSString *const MPFNoteStoreStorageKey;
extern NSUInteger const MPFNoteStoreTitleLimit;

/// Notes live in NSUserDefaults as a JSON array under `notes.v1`, newest first.
@interface MPFNoteStore : NSObject
@property (nonatomic, readonly, copy) NSArray<MPFNote *> *notes;
@property (nonatomic, readonly) BOOL isEmpty;

- (instancetype)initWithDefaults:(NSUserDefaults *)defaults;
- (MPFNote *)addNoteWithTitle:(NSString *)title body:(NSString *)body now:(NSDate *)now;
- (void)updateNote:(NSString *)identifier title:(NSString *)title body:(NSString *)body now:(NSDate *)now;
- (void)deleteNote:(NSString *)identifier;
- (nullable MPFNote *)noteWithIdentifier:(NSString *)identifier;
/// Case-insensitive match on title or body; an empty query returns everything.
- (NSArray<MPFNote *> *)notesMatching:(NSString *)query;
/// An empty title falls back to the first non-empty body line, then "Untitled"; capped at 80 characters.
+ (NSString *)normalizedTitle:(NSString *)title body:(NSString *)body;
/// One-line preview: whitespace collapsed, cut at `limit` characters with an ellipsis.
+ (NSString *)excerpt:(NSString *)body limit:(NSUInteger)limit;
@end

NS_ASSUME_NONNULL_END
