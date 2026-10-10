@import XCTest;
#import "MPFNoteStore.h"

@interface MPFNoteStoreTests : XCTestCase
@property (nonatomic, strong) NSUserDefaults *defaults;
@end

@implementation MPFNoteStoreTests

- (void)setUp {
    [super setUp];
    self.defaults = [[NSUserDefaults alloc] initWithSuiteName:@"MPFNoteStoreTests"];
    [self.defaults removePersistentDomainForName:@"MPFNoteStoreTests"];
}

- (void)testAddPutsNewestFirstAndPersists {
    MPFNoteStore *store = [[MPFNoteStore alloc] initWithDefaults:self.defaults];
    [store addNoteWithTitle:@"First" body:@"a" now:[NSDate dateWithTimeIntervalSince1970:1]];
    [store addNoteWithTitle:@"Second" body:@"b" now:[NSDate dateWithTimeIntervalSince1970:2]];
    XCTAssertEqualObjects([store.notes valueForKey:@"title"], (@[ @"Second", @"First" ]));
    MPFNoteStore *reloaded = [[MPFNoteStore alloc] initWithDefaults:self.defaults];
    XCTAssertEqualObjects(reloaded.notes, store.notes);
}

- (void)testTitleFallsBackToFirstBodyLine {
    XCTAssertEqualObjects([MPFNoteStore normalizedTitle:@"  " body:@"Buy milk\nand eggs"], @"Buy milk");
    XCTAssertEqualObjects([MPFNoteStore normalizedTitle:@"" body:@""], @"Untitled");
    NSString *longTitle = [@"" stringByPaddingToLength:100 withString:@"x" startingAtIndex:0];
    XCTAssertEqual([MPFNoteStore normalizedTitle:longTitle body:@""].length, (NSUInteger)80);
}

- (void)testSearchIsCaseInsensitiveOnTitleAndBody {
    MPFNoteStore *store = [[MPFNoteStore alloc] initWithDefaults:self.defaults];
    [store addNoteWithTitle:@"Groceries" body:@"Milk and eggs" now:[NSDate date]];
    [store addNoteWithTitle:@"Ideas" body:@"A note app" now:[NSDate date]];
    XCTAssertEqualObjects([[store notesMatching:@"MILK"] valueForKey:@"title"], @[ @"Groceries" ]);
    XCTAssertEqualObjects([[store notesMatching:@"note"] valueForKey:@"title"], @[ @"Ideas" ]);
    XCTAssertEqual([store notesMatching:@"  "].count, (NSUInteger)2);
}

- (void)testExcerptCollapsesWhitespaceAndCuts {
    XCTAssertEqualObjects([MPFNoteStore excerpt:@"a  b\n\nc" limit:60], @"a b c");
    XCTAssertEqualObjects([MPFNoteStore excerpt:@"word word word word" limit:10], @"word word…");
}

- (void)testDeleteRemovesAndPersists {
    MPFNoteStore *store = [[MPFNoteStore alloc] initWithDefaults:self.defaults];
    MPFNote *note = [store addNoteWithTitle:@"Gone" body:@"" now:[NSDate date]];
    [store deleteNote:note.identifier];
    XCTAssertTrue(store.isEmpty);
    XCTAssertTrue([[MPFNoteStore alloc] initWithDefaults:self.defaults].isEmpty);
}

@end
