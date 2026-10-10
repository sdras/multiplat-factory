#import "MPFNoteStore.h"

NSString *const MPFNoteStoreStorageKey = @"notes.v1";
NSUInteger const MPFNoteStoreTitleLimit = 80;

@interface MPFNoteStore ()
@property (nonatomic, strong) NSUserDefaults *defaults;
@property (nonatomic, strong) NSMutableArray<MPFNote *> *mutableNotes;
@end

@implementation MPFNoteStore

- (instancetype)initWithDefaults:(NSUserDefaults *)defaults {
    if ((self = [super init])) {
        _defaults = defaults;
        _mutableNotes = [NSMutableArray new];
        [self load];
    }
    return self;
}

- (NSArray<MPFNote *> *)notes {
    return [self.mutableNotes copy];
}

- (BOOL)isEmpty {
    return self.mutableNotes.count == 0;
}

- (MPFNote *)addNoteWithTitle:(NSString *)title body:(NSString *)body now:(NSDate *)now {
    MPFNote *note = [[MPFNote alloc] initWithIdentifier:[NSUUID UUID].UUIDString
                                                  title:[MPFNoteStore normalizedTitle:title body:body]
                                                   body:body
                                              updatedAt:now];
    [self.mutableNotes insertObject:note atIndex:0];
    [self save];
    return note;
}

- (void)updateNote:(NSString *)identifier title:(NSString *)title body:(NSString *)body now:(NSDate *)now {
    NSUInteger index = [self indexOf:identifier];
    if (index == NSNotFound) return;
    MPFNote *note = self.mutableNotes[index];
    note.title = [MPFNoteStore normalizedTitle:title body:body];
    note.body = body;
    note.updatedAt = now;
    [self.mutableNotes removeObjectAtIndex:index];
    [self.mutableNotes insertObject:note atIndex:0];
    [self save];
}

- (void)deleteNote:(NSString *)identifier {
    NSUInteger index = [self indexOf:identifier];
    if (index == NSNotFound) return;
    [self.mutableNotes removeObjectAtIndex:index];
    [self save];
}

- (MPFNote *)noteWithIdentifier:(NSString *)identifier {
    NSUInteger index = [self indexOf:identifier];
    return index == NSNotFound ? nil : self.mutableNotes[index];
}

- (NSUInteger)indexOf:(NSString *)identifier {
    return [self.mutableNotes indexOfObjectPassingTest:^BOOL(MPFNote *note, NSUInteger idx, BOOL *stop) {
        return [note.identifier isEqualToString:identifier];
    }];
}

- (NSArray<MPFNote *> *)notesMatching:(NSString *)query {
    NSString *q = [[query stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]] lowercaseString];
    if (q.length == 0) return self.notes;
    NSMutableArray<MPFNote *> *out = [NSMutableArray new];
    for (MPFNote *note in self.mutableNotes) {
        if ([note.title.lowercaseString containsString:q] || [note.body.lowercaseString containsString:q]) [out addObject:note];
    }
    return out;
}

+ (NSString *)normalizedTitle:(NSString *)title body:(NSString *)body {
    NSCharacterSet *whitespace = [NSCharacterSet whitespaceAndNewlineCharacterSet];
    NSString *candidate = [title stringByTrimmingCharactersInSet:whitespace];
    if (candidate.length == 0) {
        for (NSString *line in [body componentsSeparatedByCharactersInSet:[NSCharacterSet newlineCharacterSet]]) {
            NSString *trimmed = [line stringByTrimmingCharactersInSet:whitespace];
            if (trimmed.length) {
                candidate = trimmed;
                break;
            }
        }
    }
    if (candidate.length == 0) return @"Untitled";
    return candidate.length > MPFNoteStoreTitleLimit ? [candidate substringToIndex:MPFNoteStoreTitleLimit] : candidate;
}

+ (NSString *)excerpt:(NSString *)body limit:(NSUInteger)limit {
    NSMutableArray<NSString *> *words = [NSMutableArray new];
    for (NSString *part in [body componentsSeparatedByCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]]) {
        if (part.length) [words addObject:part];
    }
    NSString *collapsed = [words componentsJoinedByString:@" "];
    if (collapsed.length <= limit) return collapsed;
    NSString *cut = [[collapsed substringToIndex:limit] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
    return [cut stringByAppendingString:@"…"];
}

- (void)load {
    NSData *data = [self.defaults dataForKey:MPFNoteStoreStorageKey];
    if (!data) return;
    id json = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
    if (![json isKindOfClass:[NSArray class]]) return;
    NSMutableArray<MPFNote *> *loaded = [NSMutableArray new];
    for (id item in (NSArray *)json) {
        if (![item isKindOfClass:[NSDictionary class]]) continue;
        MPFNote *note = [MPFNote noteFromJSON:item];
        if (note) [loaded addObject:note];
    }
    [loaded sortUsingComparator:^NSComparisonResult(MPFNote *a, MPFNote *b) {
        return [b.updatedAt compare:a.updatedAt];
    }];
    self.mutableNotes = loaded;
}

- (void)save {
    NSMutableArray *json = [NSMutableArray new];
    for (MPFNote *note in self.mutableNotes) [json addObject:[note jsonObject]];
    NSData *data = [NSJSONSerialization dataWithJSONObject:json options:0 error:NULL];
    if (data) [self.defaults setObject:data forKey:MPFNoteStoreStorageKey];
}

@end
