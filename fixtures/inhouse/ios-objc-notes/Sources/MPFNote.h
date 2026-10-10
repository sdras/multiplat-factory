@import Foundation;

NS_ASSUME_NONNULL_BEGIN

@interface MPFNote : NSObject
@property (nonatomic, copy) NSString *identifier;
@property (nonatomic, copy) NSString *title;
@property (nonatomic, copy) NSString *body;
@property (nonatomic, strong) NSDate *updatedAt;

- (instancetype)initWithIdentifier:(NSString *)identifier title:(NSString *)title body:(NSString *)body updatedAt:(NSDate *)updatedAt;
/// `{ "id", "title", "body", "updatedAt": ISO-8601 }`
- (NSDictionary<NSString *, id> *)jsonObject;
+ (nullable instancetype)noteFromJSON:(NSDictionary *)json;
@end

NS_ASSUME_NONNULL_END
