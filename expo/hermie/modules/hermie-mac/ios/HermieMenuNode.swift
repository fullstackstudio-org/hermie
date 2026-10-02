import UIKit

/**
 One line of a menu, as JavaScript describes it.

 Parsed out of a plain dictionary rather than declared as an ExpoModulesCore `Record`, for one
 reason: a menu is a TREE, and a `Record` whose field type is an array of itself is a recursive
 reflection problem. A dictionary walk is the same amount of code and has no such question in it.

 Everything is optional except `id` and `title`. A node with children is a submenu and its own `id`
 is never reported — UIKit does not select a submenu, it opens one — which is why an empty `id` is
 only rejected for a leaf.
 */
struct HermieMenuNode {
  let id: String
  let title: String
  let systemImage: String?
  let destructive: Bool
  let disabled: Bool
  /// Drawn with a checkmark. A colour swatch and a filter use it; nothing else does.
  let selected: Bool
  /// Children flattened into the parent menu as a titled section instead of a submenu.
  let inline: Bool
  let children: [HermieMenuNode]

  init?(_ raw: Any) {
    guard let dictionary = raw as? [String: Any] else {
      return nil
    }

    let children = (dictionary["children"] as? [Any])?.compactMap(HermieMenuNode.init) ?? []
    let id = dictionary["id"] as? String ?? ""

    // A leaf with no id could be selected and then not be reportable, which is worse than not
    // drawing it: the reader would tap a line that does nothing.
    guard !id.isEmpty || !children.isEmpty else {
      return nil
    }

    self.id = id
    self.title = dictionary["title"] as? String ?? ""
    self.systemImage = dictionary["systemImage"] as? String
    self.destructive = dictionary["destructive"] as? Bool ?? false
    self.disabled = dictionary["disabled"] as? Bool ?? false
    self.selected = dictionary["selected"] as? Bool ?? false
    self.inline = dictionary["inline"] as? Bool ?? false
    self.children = children
  }

  static func parse(_ raw: [Any]) -> [HermieMenuNode] {
    raw.compactMap(HermieMenuNode.init)
  }

  /**
   The UIKit element for this node.

   `onSelect` is called with the leaf's id. It is handed in rather than captured from a view so the
   same builder serves the row menus and the Mac menu bar.
   */
  func element(onSelect: @escaping (String) -> Void) -> UIMenuElement {
    let image = systemImage.flatMap { UIImage(systemName: $0) }

    if !children.isEmpty {
      return UIMenu(
        title: title,
        image: image,
        options: inline ? .displayInline : [],
        children: children.map { $0.element(onSelect: onSelect) }
      )
    }

    var attributes: UIMenuElement.Attributes = []

    if destructive {
      attributes.insert(.destructive)
    }

    if disabled {
      attributes.insert(.disabled)
    }

    let id = self.id
    let action = UIAction(title: title, image: image, attributes: attributes) { _ in
      onSelect(id)
    }

    action.state = selected ? .on : .off

    return action
  }
}
