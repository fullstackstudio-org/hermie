#if os(macOS)
  import AppKit
  import SwiftUI

  /// `TranscriptList` on the Mac: an `NSCollectionView` with the same layout
  /// model as the iPhone and iPad list (`TranscriptListLayoutModel`) and
  /// SwiftUI rows in `NSHostingController`s.
  ///
  /// `NSCollectionView` rather than `NSTableView`, so that both platforms run
  /// one layout and one anchor rule: a table keeps its own row-height cache,
  /// re-asks every row's height on `reloadData`, and would need anchoring of
  /// its own around `noteHeightOfRows`.
  ///
  /// A row is measured with `sizeThatFits` when it is about to be shown, and
  /// reports its own height afterwards (`onGeometryChange` on content that
  /// takes its ideal height), so a reply that grows or a disclosure that opens
  /// re-measures that row alone. Every height change goes through the anchor
  /// rule, as on iOS.
  struct CollectionTranscriptList<Item: Identifiable & Equatable & Sendable, Row: View>: NSViewRepresentable
  where Item.ID: Sendable {
    let items: TranscriptListItems<Item>
    let state: TranscriptListState
    let spacing: CGFloat
    let insets: EdgeInsets
    let commandSerial: Int
    let row: (Item) -> Row

    func makeCoordinator() -> MacTranscriptCoordinator<Item, Row> {
      MacTranscriptCoordinator(state: state, row: row)
    }

    func makeNSView(context: Context) -> NSScrollView {
      context.coordinator.scrollView
    }

    func updateNSView(_ view: NSScrollView, context: Context) {
      let coordinator = context.coordinator
      coordinator.row = row
      coordinator.update(environment: context.environment)
      coordinator.update(spacing: spacing, insets: insets)
      coordinator.update(items: items.elements)
      coordinator.perform(commandSerial: commandSerial)
    }
  }

  /// The scroll view, with hooks around layout and the reader's scrolling.
  final class TranscriptScrollView: NSScrollView {
    var willResize: ((CGSize, CGSize) -> Void)?
    var didResize: ((CGSize, CGSize) -> Void)?
    var didScrollByReader: (() -> Void)?
    private var laidOutSize: CGSize = .zero

    override func layout() {
      let old = laidOutSize
      let new = contentView.bounds.size
      let resized = old != .zero && old != new
      if resized { willResize?(old, new) }
      super.layout()
      laidOutSize = contentView.bounds.size
      if resized { didResize?(old, new) }
    }

    override func scrollWheel(with event: NSEvent) {
      super.scrollWheel(with: event)
      didScrollByReader?()
    }
  }

  /// Positions from the model; nothing else.
  final class TranscriptMacLayout<ID: Hashable>: NSCollectionViewLayout {
    var model = TranscriptListLayoutModel<ID>()

    override var collectionViewContentSize: NSSize {
      NSSize(width: model.width, height: model.contentHeight)
    }

    override func layoutAttributesForElements(in rect: NSRect) -> [NSCollectionViewLayoutAttributes] {
      model.positions(intersecting: rect.minY, rect.maxY).map(attributes(at:))
    }

    override func layoutAttributesForItem(at indexPath: IndexPath) -> NSCollectionViewLayoutAttributes? {
      indexPath.item < model.count ? attributes(at: indexPath.item) : nil
    }

    private func attributes(at position: Int) -> NSCollectionViewLayoutAttributes {
      let attributes = NSCollectionViewLayoutAttributes(forItemWith: IndexPath(item: position, section: 0))
      attributes.frame = model.frame(at: position)
      return attributes
    }

    override func shouldInvalidateLayout(forBoundsChange newBounds: NSRect) -> Bool {
      newBounds.width != model.width
    }
  }

  /// One row: a hosting controller whose view is the item's view.
  final class TranscriptHostingItem: NSCollectionViewItem {
    static let identifier = NSUserInterfaceItemIdentifier("transcript.row")
    let host = NSHostingController(rootView: AnyView(EmptyView()))

    override func loadView() {
      host.sizingOptions = []
      view = host.view
    }
  }

  /// Owns the collection view and keeps it in step with the rows.
  @MainActor
  final class MacTranscriptCoordinator<Item: Identifiable & Equatable & Sendable, Row: View>: NSObject,
    NSCollectionViewDataSource, NSCollectionViewDelegate
  where Item.ID: Sendable {
    let state: TranscriptListState
    var row: (Item) -> Row
    let layout = TranscriptMacLayout<Item.ID>()
    let scrollView = TranscriptScrollView()
    let collectionView = NSCollectionView()

    private var items: [Item] = []
    private var environment = EnvironmentValues()
    private var appearance: Appearance?
    private var lastCommand = 0
    private var loaded = false
    private var applying = 0
    private var pinned = true
    private var resizeAnchor: TranscriptListLayoutModel<Item.ID>.Anchor?

    init(state: TranscriptListState, row: @escaping (Item) -> Row) {
      self.state = state
      self.row = row
      super.init()
      collectionView.collectionViewLayout = layout
      collectionView.dataSource = self
      collectionView.delegate = self
      collectionView.isSelectable = false
      collectionView.backgroundColors = [.clear]
      collectionView.register(TranscriptHostingItem.self, forItemWithIdentifier: TranscriptHostingItem.identifier)
      collectionView.setAccessibilityIdentifier("transcript.list")
      scrollView.documentView = collectionView
      scrollView.drawsBackground = false
      scrollView.hasVerticalScroller = true
      scrollView.automaticallyAdjustsContentInsets = false
      scrollView.contentView.postsBoundsChangedNotifications = true
      scrollView.setAccessibilityIdentifier("transcript.scroll")
      NotificationCenter.default.addObserver(
        self, selector: #selector(clipViewBoundsChanged), name: NSView.boundsDidChangeNotification,
        object: scrollView.contentView)
      scrollView.willResize = { [unowned self] old, new in willResize(from: old, to: new) }
      scrollView.didResize = { [unowned self] old, new in didResize(from: old, to: new) }
      scrollView.didScrollByReader = { [unowned self] in
        updateEdges()
        pinned = state.isAtBottom
      }
    }

    // MARK: Geometry

    private var contentInsets: NSEdgeInsets { scrollView.contentInsets }
    private var offset: CGFloat { scrollView.contentView.bounds.origin.y }
    private var visibleTop: CGFloat { offset + contentInsets.top }

    private func maxOffset() -> CGFloat {
      max(-contentInsets.top, layout.model.contentHeight + contentInsets.bottom - scrollView.contentView.bounds.height)
    }

    private func setOffset(_ y: CGFloat) {
      scrollView.contentView.scroll(to: NSPoint(x: 0, y: y))
      scrollView.reflectScrolledClipView(scrollView.contentView)
    }

    private func layoutWidth() -> CGFloat {
      scrollView.contentView.bounds.width
    }

    /// Makes the collection view as tall as the content, so the clip view can
    /// scroll over all of it.
    private func syncDocumentSize() {
      let size = NSSize(width: layoutWidth(), height: max(layout.model.contentHeight, 1))
      if collectionView.frame.size != size {
        collectionView.setFrameSize(size)
      }
    }

    // MARK: Updates

    private struct Appearance: Equatable {
      var colorScheme: ColorScheme
      var dynamicTypeSize: DynamicTypeSize
      var layoutDirection: LayoutDirection
      var contrast: ColorSchemeContrast
    }

    func update(environment: EnvironmentValues) {
      self.environment = environment
      let new = Appearance(
        colorScheme: environment.colorScheme, dynamicTypeSize: environment.dynamicTypeSize,
        layoutDirection: environment.layoutDirection, contrast: environment.colorSchemeContrast)
      if let appearance, appearance != new, loaded {
        self.appearance = new
        for indexPath in collectionView.indexPathsForVisibleItems() {
          configure(indexPath.item)
        }
      }
      appearance = new
    }

    func update(spacing: CGFloat, insets: EdgeInsets) {
      if layout.model.spacing != spacing {
        layout.model.spacing = spacing
        layout.invalidateLayout()
      }
      let new = NSEdgeInsets(top: insets.top, left: 0, bottom: insets.bottom, right: 0)
      let current = scrollView.contentInsets
      guard current.top != new.top || current.bottom != new.bottom else { return }
      let keepBottom = pinned
      withApplying {
        scrollView.contentInsets = new
        if keepBottom { setOffset(maxOffset()) }
      }
    }

    func update(items newItems: [Item]) {
      let old = items
      items = newItems
      if layout.model.width != layoutWidth() {
        layout.model.setWidth(layoutWidth())
      }
      if !loaded {
        loaded = true
        layout.model.setIDs(newItems.map(\.id))
        withApplying {
          collectionView.reloadData()
          syncDocumentSize()
          setOffset(maxOffset())
          measureVisible()
          setOffset(maxOffset())
          collectionView.layoutSubtreeIfNeeded()
        }
        updateEdges()
        return
      }
      if old.count == newItems.count && zip(old, newItems).allSatisfy({ $0.id == $1.id }) {
        for indexPath in collectionView.indexPathsForVisibleItems()
        where indexPath.item < newItems.count && old[indexPath.item] != newItems[indexPath.item] {
          configure(indexPath.item)
        }
        return
      }
      applyStructuralChange(from: old, to: newItems)
    }

    /// As on iOS: one batch of inserts and deletes, so rows on screen keep
    /// their items, then the anchor row back in place.
    private func applyStructuralChange(from old: [Item], to newItems: [Item]) {
      #if DEBUG
        let before = onScreenPositions()
        defer { TranscriptListDiagnostics.recordShift(before: before, after: onScreenPositions()) }
      #endif
      let keepBottom = pinned
      let anchor = keepBottom ? nil : layout.model.anchor(visibleTop: visibleTop)
      let newIDs = newItems.map(\.id)
      let difference = newIDs.difference(from: layout.model.ids)
      let small = difference.insertions.count + difference.removals.count <= 600
      layout.model.setIDs(newIDs)
      withApplying {
        syncDocumentSize()
        if let anchor, let top = layout.model.visibleTop(restoring: anchor) {
          setOffset(top - contentInsets.top)
        }
        if small {
          var deleted = Set<IndexPath>()
          var inserted = Set<IndexPath>()
          for change in difference {
            switch change {
            case .remove(let offset, _, _): deleted.insert(IndexPath(item: offset, section: 0))
            case .insert(let offset, _, _): inserted.insert(IndexPath(item: offset, section: 0))
            }
          }
          collectionView.performBatchUpdates {
            collectionView.deleteItems(at: deleted)
            collectionView.insertItems(at: inserted)
          }
          let oldByID = Dictionary(old.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
          for indexPath in collectionView.indexPathsForVisibleItems() where indexPath.item < newItems.count {
            if let before = oldByID[newItems[indexPath.item].id], before != newItems[indexPath.item] {
              configure(indexPath.item)
            }
          }
        } else {
          collectionView.reloadData()
        }
        measureVisible()
        if keepBottom {
          setOffset(maxOffset())
        } else if let anchor, let top = layout.model.visibleTop(restoring: anchor) {
          setOffset(top - contentInsets.top)
        }
        collectionView.layoutSubtreeIfNeeded()
      }
      updateEdges()
    }

    #if DEBUG
      /// Where each row on screen sits in the viewport, from its item view.
      private func onScreenPositions() -> [Item.ID: CGFloat] {
        var positions: [Item.ID: CGFloat] = [:]
        for indexPath in collectionView.indexPathsForVisibleItems() where indexPath.item < layout.model.count {
          if let view = collectionView.item(at: indexPath)?.view {
            positions[layout.model.ids[indexPath.item]] = view.frame.minY - offset
          }
        }
        return positions
      }
    #endif

    private func withApplying(_ body: () -> Void) {
      applying += 1
      body()
      applying -= 1
    }

    // MARK: Rows

    /// Gives the visible item at `position` its row again. A change of height
    /// comes back from the row itself.
    private func configure(_ position: Int) {
      guard let item = collectionView.item(at: IndexPath(item: position, section: 0)) as? TranscriptHostingItem else {
        return
      }
      fill(item, position: position)
    }

    private func fill(_ cell: TranscriptHostingItem, position: Int) {
      cell.host.rootView = AnyView(rowContent(items[position], reporting: true))
    }

    /// A row as an item and the sizing host draw it: at its ideal height
    /// whatever height it is offered, and (in an item) reporting that height
    /// when its content changes it.
    private func rowContent(_ item: Item, reporting: Bool) -> some View {
      let id = item.id
      return measuredContent(item)
        .onGeometryChange(for: CGFloat.self) { ceil($0.size.height) } action: { [weak self] height in
          if reporting { self?.rowReported(id, height: height) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    /// The row at its ideal height, as the sizer measures it. Without the
    /// cell's flexible frame: `NSHostingController` answers an unbounded
    /// height for a view that takes all it is offered.
    private func measuredContent(_ item: Item) -> some View {
      RowEnvironmentBridge(captured: environment, content: TranscriptListRow(item: item, row: row).equatable())
        .fixedSize(horizontal: false, vertical: true)
    }

    /// Measures rows off screen, at the layout's width.
    private let sizer = NSHostingController(rootView: AnyView(EmptyView()))
    /// How far beyond the viewport rows are measured ahead of being shown.
    private let lookahead: CGFloat = 400

    private func measureRow(at position: Int) -> CGFloat? {
      guard position < items.count, layout.model.width > 0 else { return nil }
      sizer.rootView = AnyView(measuredContent(items[position]).frame(width: layout.model.width))
      let height = sizer.sizeThatFits(in: CGSize(width: layout.model.width, height: .greatestFiniteMagnitude)).height
      sizer.rootView = AnyView(EmptyView())
      return height.isFinite ? ceil(height) : nil
    }

    /// Measures every unmeasured row in and around the viewport before it is
    /// shown, moving the offset by what changed above the reader (or keeping
    /// the bottom), so nothing visible moves.
    private func measureVisible() {
      var adjustment: CGFloat = 0
      var changed = false
      for _ in 0..<4 {
        let top = offset + adjustment
        let bottom = top + scrollView.contentView.bounds.height
        let todo = layout.model.positions(intersecting: top - lookahead, bottom + lookahead)
          .filter { !layout.model.isMeasured(layout.model.ids[$0]) }
        guard !todo.isEmpty else { break }
        for position in todo {
          guard let height = measureRow(at: position) else { continue }
          let delta = layout.model.setHeight(height, for: layout.model.ids[position])
          changed = changed || delta != 0
          adjustment += layout.model.offsetAdjustment(
            forRowAt: position, delta: delta, visibleTop: top + contentInsets.top, pinnedToBottom: false)
        }
      }
      guard changed else { return }
      withApplying {
        layout.invalidateLayout()
        syncDocumentSize()
        if pinned {
          setOffset(maxOffset())
        } else if adjustment != 0 {
          setOffset(offset + adjustment)
        }
      }
    }

    /// A row's own report of its height, after its content changed.
    private func rowReported(_ id: Item.ID, height: CGFloat) {
      // Reported from inside the collection view's layout; applied on the
      // next turn of the main queue, as on iOS, so the layout acts on it.
      let first = reported.isEmpty
      reported[id] = height
      guard first else { return }
      DispatchQueue.main.async { [weak self] in
        self?.applyReports()
      }
    }

    private var reported: [Item.ID: CGFloat] = [:]

    private func applyReports() {
      let reports = reported
      reported = [:]
      for (id, height) in reports {
        guard let position = layout.model.index[id], height > 0 else { continue }
        setHeight(height, at: position)
      }
      collectionView.layoutSubtreeIfNeeded()
    }

    /// The one place a height changes: the anchor rule, then the layout.
    private func setHeight(_ height: CGFloat, at position: Int) {
      let top = visibleTop
      let id = layout.model.ids[position]
      guard layout.model.accepts(height, for: id) else { return }
      let delta = layout.model.setHeight(height, for: id)
      guard delta != 0 else { return }
      let adjustment = layout.model.offsetAdjustment(
        forRowAt: position, delta: delta, visibleTop: top, pinnedToBottom: pinned)
      withApplying {
        layout.invalidateLayout()
        syncDocumentSize()
        if pinned {
          setOffset(maxOffset())
        } else if adjustment != 0 {
          setOffset(offset + adjustment)
        }
      }
    }

    // MARK: Resizing

    private func willResize(from old: CGSize, to new: CGSize) {
      resizeAnchor = pinned || old.width == new.width ? nil : layout.model.anchor(visibleTop: visibleTop)
    }

    private func didResize(from old: CGSize, to new: CGSize) {
      withApplying {
        if old.width != new.width {
          layout.model.setWidth(layoutWidth())
          layout.invalidateLayout()
        }
        for _ in 0..<2 {
          if pinned {
            setOffset(maxOffset())
          } else if let anchor = resizeAnchor, let top = layout.model.visibleTop(restoring: anchor) {
            setOffset(top - contentInsets.top)
          }
          measureVisible()
        }
        if pinned {
          setOffset(maxOffset())
        } else if let anchor = resizeAnchor, let top = layout.model.visibleTop(restoring: anchor) {
          setOffset(top - contentInsets.top)
        }
        syncDocumentSize()
      }
      resizeAnchor = nil
      updateEdges()
    }

    // MARK: Commands

    func perform(commandSerial: Int) {
      guard commandSerial != lastCommand else { return }
      lastCommand = commandSerial
      switch state.take() {
      case .bottom(let animated):
        pinned = true
        scroll(to: maxOffset(), animated: animated)
      case .item(let id, let anchor, let animated):
        guard let id = id.base as? Item.ID, let frame = layout.model.frame(of: id) else { return }
        let visible = scrollView.contentView.bounds.height - contentInsets.top - contentInsets.bottom
        let y = frame.minY - contentInsets.top - anchor.y * max(0, visible - frame.height)
        pinned = false
        scroll(to: min(max(y, -contentInsets.top), maxOffset()), animated: animated)
      case .pan(let delta):
        // A stand-in for the reader's own scrolling: it decides `pinned` too.
        setOffset(min(max(offset + delta, -contentInsets.top), maxOffset()))
        updateEdges()
        pinned = state.isAtBottom
      case nil:
        break
      }
    }

    private func scroll(to y: CGFloat, animated: Bool) {
      if animated {
        // The clip view's bounds notifications keep the edges current while it
        // animates; `pinned` was set by the command.
        let clipView = scrollView.contentView
        NSAnimationContext.runAnimationGroup { context in
          context.duration = 0.25
          clipView.animator().setBoundsOrigin(NSPoint(x: 0, y: y))
        }
      } else {
        setOffset(y)
      }
    }

    // MARK: Data source and delegate

    func collectionView(_ collectionView: NSCollectionView, numberOfItemsInSection section: Int) -> Int {
      items.count
    }

    func collectionView(
      _ collectionView: NSCollectionView, itemForRepresentedObjectAt indexPath: IndexPath
    ) -> NSCollectionViewItem {
      let cell = collectionView.makeItem(withIdentifier: TranscriptHostingItem.identifier, for: indexPath)
      if let cell = cell as? TranscriptHostingItem {
        fill(cell, position: indexPath.item)
      }
      return cell
    }

    func collectionView(
      _ collectionView: NSCollectionView, willDisplay item: NSCollectionViewItem,
      forRepresentedObjectAt indexPath: IndexPath
    ) {
      // Measured ahead in `clipViewBoundsChanged`; nothing to do here.
    }

    @objc private func clipViewBoundsChanged() {
      guard applying == 0 else { return }
      // The reader scrolled: rows about to come into view are measured now,
      // before they are drawn.
      measureVisible()
      updateEdges()
    }

    private func updateEdges() {
      let visibleBottom = offset + scrollView.contentView.bounds.height - contentInsets.bottom
      let atBottom = visibleBottom >= layout.model.contentHeight - state.bottomThreshold
      if state.isAtBottom != atBottom {
        state.isAtBottom = atBottom
      }
      let top = visibleTop
      state.topVisibleID = layout.model.anchor(visibleTop: top).map { AnyHashable($0.id) }
      let nearTop = layout.model.contentHeight > scrollView.contentView.bounds.height && top <= state.nearTopThreshold
      if nearTop {
        if state.nearTopArmed {
          state.nearTopArmed = false
          state.callOnNearTopLater()
        }
      } else {
        state.nearTopArmed = true
      }
    }
  }
#endif
