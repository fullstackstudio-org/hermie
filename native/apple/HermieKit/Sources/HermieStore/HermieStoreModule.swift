/// Marks the `HermieStore` module until it holds the keychain and SQLite
/// stores, so the target compiles and its place in the dependency graph can be
/// tested.
public enum HermieStoreModule {
  public static let name = "HermieStore"
}
