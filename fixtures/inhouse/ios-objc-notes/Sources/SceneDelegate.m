#import "SceneDelegate.h"
#import "MPFNoteStore.h"
#import "MPFNotesListViewController.h"

@implementation SceneDelegate

- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session options:(UISceneConnectionOptions *)connectionOptions {
    if (![scene isKindOfClass:[UIWindowScene class]]) return;
    UIWindow *window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
    MPFNoteStore *store = [[MPFNoteStore alloc] initWithDefaults:[NSUserDefaults standardUserDefaults]];
    MPFNotesListViewController *list = [[MPFNotesListViewController alloc] initWithStore:store];
    window.rootViewController = [[UINavigationController alloc] initWithRootViewController:list];
    [window makeKeyAndVisible];
    self.window = window;
}

@end
