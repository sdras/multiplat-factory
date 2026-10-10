#import "MPFNoteEditorViewController.h"
#import "MPFNoteStore.h"

@interface MPFNoteEditorViewController ()
@property (nonatomic, strong) MPFNoteStore *store;
@property (nonatomic, copy, nullable) NSString *noteIdentifier;
@property (nonatomic, strong) UITextField *titleField;
@property (nonatomic, strong) UITextView *bodyView;
@end

@implementation MPFNoteEditorViewController

- (instancetype)initWithStore:(MPFNoteStore *)store noteIdentifier:(NSString *)noteIdentifier {
    if ((self = [super initWithNibName:nil bundle:nil])) {
        _store = store;
        _noteIdentifier = [noteIdentifier copy];
    }
    return self;
}

- (void)viewDidLoad {
    [super viewDidLoad];
    self.view.backgroundColor = [UIColor systemBackgroundColor];
    self.title = self.noteIdentifier ? @"Edit note" : @"New note";
    self.navigationItem.largeTitleDisplayMode = UINavigationItemLargeTitleDisplayModeNever;

    UIBarButtonItem *save = [[UIBarButtonItem alloc] initWithTitle:@"Save" style:UIBarButtonItemStyleDone target:self action:@selector(saveTapped)];
    save.accessibilityIdentifier = @"save-note";
    self.navigationItem.rightBarButtonItem = save;

    self.titleField = [UITextField new];
    self.titleField.placeholder = @"Title";
    self.titleField.font = [UIFont preferredFontForTextStyle:UIFontTextStyleTitle2];
    self.titleField.borderStyle = UITextBorderStyleRoundedRect;
    self.titleField.accessibilityIdentifier = @"note-title";

    self.bodyView = [UITextView new];
    self.bodyView.font = [UIFont preferredFontForTextStyle:UIFontTextStyleBody];
    self.bodyView.layer.borderColor = [UIColor separatorColor].CGColor;
    self.bodyView.layer.borderWidth = 1;
    self.bodyView.layer.cornerRadius = 8;
    self.bodyView.accessibilityIdentifier = @"note-body";

    UIStackView *stack = [[UIStackView alloc] initWithArrangedSubviews:@[ self.titleField, self.bodyView ]];
    stack.axis = UILayoutConstraintAxisVertical;
    stack.spacing = 12;
    stack.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:stack];
    UILayoutGuide *safe = self.view.safeAreaLayoutGuide;
    [NSLayoutConstraint activateConstraints:@[
        [stack.topAnchor constraintEqualToAnchor:safe.topAnchor constant:16],
        [stack.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor constant:16],
        [stack.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor constant:-16],
        [self.bodyView.heightAnchor constraintEqualToConstant:240],
    ]];

    MPFNote *note = self.noteIdentifier ? [self.store noteWithIdentifier:self.noteIdentifier] : nil;
    if (note) {
        self.titleField.text = note.title;
        self.bodyView.text = note.body;
        UIButton *delete = [UIButton buttonWithType:UIButtonTypeSystem];
        [delete setTitle:@"Delete note" forState:UIControlStateNormal];
        [delete setTitleColor:[UIColor systemRedColor] forState:UIControlStateNormal];
        delete.accessibilityIdentifier = @"delete-note";
        [delete addTarget:self action:@selector(deleteTapped) forControlEvents:UIControlEventTouchUpInside];
        [stack addArrangedSubview:delete];
    }
}

- (void)saveTapped {
    NSString *title = self.titleField.text ?: @"";
    NSString *body = self.bodyView.text ?: @"";
    NSCharacterSet *whitespace = [NSCharacterSet whitespaceAndNewlineCharacterSet];
    BOOL blank = [title stringByTrimmingCharactersInSet:whitespace].length == 0 && [body stringByTrimmingCharactersInSet:whitespace].length == 0;
    if (!blank) {
        if (self.noteIdentifier) {
            [self.store updateNote:self.noteIdentifier title:title body:body now:[NSDate date]];
        } else {
            [self.store addNoteWithTitle:title body:body now:[NSDate date]];
        }
    }
    [self.navigationController popViewControllerAnimated:YES];
}

- (void)deleteTapped {
    if (!self.noteIdentifier) return;
    [self.store deleteNote:self.noteIdentifier];
    [self.navigationController popViewControllerAnimated:YES];
}

@end
