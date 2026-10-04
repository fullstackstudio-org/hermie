import Foundation

extension GatewaySession {
  /// The reads behind the Activity screen, over this session's link, store and roster.
  public var activityService: ActivityService {
    ActivityService(link: link, store: store, roster: roster)
  }

  /// The model behind the Activity screen. A screen builds one per time it is opened: what it derives is
  /// a view of the chats, never a second copy of them.
  public func activity() -> ActivityModel {
    ActivityModel(backend: activityService)
  }
}
