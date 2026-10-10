#import "MPFNote.h"

static NSISO8601DateFormatter *MPFDateFormatter(void) {
    static NSISO8601DateFormatter *formatter;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        formatter = [NSISO8601DateFormatter new];
        formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime;
    });
    return formatter;
}

@implementation MPFNote

- (instancetype)initWithIdentifier:(NSString *)identifier title:(NSString *)title body:(NSString *)body updatedAt:(NSDate *)updatedAt {
    if ((self = [super init])) {
        _identifier = [identifier copy];
        _title = [title copy];
        _body = [body copy];
        _updatedAt = updatedAt;
    }
    return self;
}

- (NSDictionary<NSString *, id> *)jsonObject {
    return @{ @"id": self.identifier, @"title": self.title, @"body": self.body, @"updatedAt": [MPFDateFormatter() stringFromDate:self.updatedAt] };
}

+ (instancetype)noteFromJSON:(NSDictionary *)json {
    NSString *identifier = json[@"id"];
    NSString *title = json[@"title"];
    NSString *body = json[@"body"];
    NSString *date = json[@"updatedAt"];
    if (![identifier isKindOfClass:[NSString class]] || ![title isKindOfClass:[NSString class]] ||
        ![body isKindOfClass:[NSString class]] || ![date isKindOfClass:[NSString class]]) {
        return nil;
    }
    NSDate *updatedAt = [MPFDateFormatter() dateFromString:date];
    if (!updatedAt) return nil;
    return [[MPFNote alloc] initWithIdentifier:identifier title:title body:body updatedAt:updatedAt];
}

- (BOOL)isEqual:(id)object {
    if (![object isKindOfClass:[MPFNote class]]) return NO;
    MPFNote *other = object;
    return [self.identifier isEqualToString:other.identifier] && [self.title isEqualToString:other.title] &&
           [self.body isEqualToString:other.body] && [self.updatedAt isEqualToDate:other.updatedAt];
}

- (NSUInteger)hash {
    return self.identifier.hash;
}

@end
