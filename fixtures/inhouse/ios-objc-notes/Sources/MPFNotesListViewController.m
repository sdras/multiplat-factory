#import "MPFNotesListViewController.h"
#import "MPFNoteEditorViewController.h"
#import "MPFNoteStore.h"

@interface MPFNotesListViewController () <UISearchResultsUpdating>
@property (nonatomic, strong) MPFNoteStore *store;
@property (nonatomic, copy) NSArray<MPFNote *> *shown;
@property (nonatomic, strong) UISearchController *search;
@property (nonatomic, strong) UILabel *emptyLabel;
@end

@implementation MPFNotesListViewController

- (instancetype)initWithStore:(MPFNoteStore *)store {
    if ((self = [super initWithStyle:UITableViewStyleInsetGrouped])) {
        _store = store;
        _shown = @[];
    }
    return self;
}

- (void)viewDidLoad {
    [super viewDidLoad];
    self.title = @"Notes";
    self.navigationController.navigationBar.prefersLargeTitles = YES;
    self.tableView.accessibilityIdentifier = @"notes-list";
    [self.tableView registerClass:[UITableViewCell class] forCellReuseIdentifier:@"note"];

    UIBarButtonItem *add = [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemAdd target:self action:@selector(addTapped)];
    add.accessibilityIdentifier = @"add-note";
    self.navigationItem.rightBarButtonItem = add;

    self.search = [[UISearchController alloc] initWithSearchResultsController:nil];
    self.search.searchResultsUpdater = self;
    self.search.obscuresBackgroundDuringPresentation = NO;
    self.search.searchBar.placeholder = @"Search notes";
    self.search.searchBar.searchTextField.accessibilityIdentifier = @"search-notes";
    self.navigationItem.searchController = self.search;
    self.navigationItem.hidesSearchBarWhenScrolling = NO;

    self.emptyLabel = [UILabel new];
    self.emptyLabel.text = @"No notes yet. Tap + to write one.";
    self.emptyLabel.textAlignment = NSTextAlignmentCenter;
    self.emptyLabel.textColor = [UIColor secondaryLabelColor];
    self.emptyLabel.numberOfLines = 0;
    self.emptyLabel.accessibilityIdentifier = @"empty-state";
}

- (void)viewWillAppear:(BOOL)animated {
    [super viewWillAppear:animated];
    [self reload];
}

- (void)reload {
    self.shown = [self.store notesMatching:self.search.searchBar.text ?: @""];
    self.tableView.backgroundView = self.shown.count == 0 ? self.emptyLabel : nil;
    [self.tableView reloadData];
}

- (void)updateSearchResultsForSearchController:(UISearchController *)searchController {
    [self reload];
}

- (void)addTapped {
    MPFNoteEditorViewController *editor = [[MPFNoteEditorViewController alloc] initWithStore:self.store noteIdentifier:nil];
    [self.navigationController pushViewController:editor animated:YES];
}

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
    return (NSInteger)self.shown.count;
}

- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)indexPath {
    UITableViewCell *cell = [tableView dequeueReusableCellWithIdentifier:@"note" forIndexPath:indexPath];
    MPFNote *note = self.shown[(NSUInteger)indexPath.row];
    UIListContentConfiguration *content = [cell defaultContentConfiguration];
    content.text = note.title;
    content.secondaryText = [MPFNoteStore excerpt:note.body limit:60];
    cell.contentConfiguration = content;
    cell.accessoryType = UITableViewCellAccessoryDisclosureIndicator;
    cell.accessibilityIdentifier = [NSString stringWithFormat:@"note-row-%ld", (long)indexPath.row];
    return cell;
}

- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)indexPath {
    [tableView deselectRowAtIndexPath:indexPath animated:YES];
    MPFNote *note = self.shown[(NSUInteger)indexPath.row];
    MPFNoteEditorViewController *editor = [[MPFNoteEditorViewController alloc] initWithStore:self.store noteIdentifier:note.identifier];
    [self.navigationController pushViewController:editor animated:YES];
}

- (void)tableView:(UITableView *)tableView commitEditingStyle:(UITableViewCellEditingStyle)editingStyle forRowAtIndexPath:(NSIndexPath *)indexPath {
    if (editingStyle != UITableViewCellEditingStyleDelete) return;
    [self.store deleteNote:self.shown[(NSUInteger)indexPath.row].identifier];
    [self reload];
}

@end
