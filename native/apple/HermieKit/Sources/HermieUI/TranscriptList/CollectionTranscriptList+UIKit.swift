#if os(iOS)
  import SwiftUI
  import UIKit

  /// `TranscriptList` on iPhone and iPad: a `UICollectionView` with a layout of
  /// its own (`TranscriptListLayoutModel`) and SwiftUI rows in
  /// `UIHostingConfiguration` cells.
  ///
  /// Everything that moves the content is done here, synchronously, inside the
  /// update that causes it, so the reader never sees an intermediate frame:
  ///
  /// - a structural change (rows added, removed or rolled up) is one batch of
  ///   inserts and deletes; the anchor row is taken before it and put back
  ///   after it, to the point;
  /// - rows are measured before they are shown (see `TranscriptCollectionLayout`),
  ///   and a row that gets taller or shorter above the anchor moves the offset
  ///   by the same amount, so scrolling up through rows never measured, and a
  ///   disclosure opening above the reader, do not move what they read;
  /// - while the reader is at the bottom, the bottom edge is kept instead:
  ///   a growing reply, a taller composer and the keyboard keep the newest row
  ///   in view;
  /// - a resize (rotation, split view, the keyboard) keeps the anchor row, or
  ///   the bottom, and measures again at a new width.
  ///
  /// A streamed delta, which changes one row and no ids, reconfigures that one
  /// cell if it is on screen and touches nothing else.
  struct CollectionTranscriptList<Item: Identifiable & Equatable & Sendable, Row: View>: UIViewRepresentable
  where Item.ID: Sendable {
    let items: TranscriptListItems<Item>
    let state: TranscriptListState
    let spacing: CGFloat
    let insets: EdgeInsets
    let commandSerial: Int
    let row: (Item) -> Row

    func makeCoordinator() -> CollectionTranscriptCoordinator<Item, Row> {
      CollectionTranscriptCoordinator(state: state, row: row)
    }

    func makeUIView(context: Context) -> UICollectionView {
      context.coordinator.collectionView
    }

    func updateUIView(_ view: UICollectionView, context: Context) {
      let coordinator = context.coordinator
      coordinator.row = row
      coordinator.update(environment: context.environment)
      coordinator.update(spacing: spacing, insets: insets)
      coordinator.update(items: items.elements)
      coordinator.perform(commandSerial: commandSerial)
    }
  }

  /// The collection view, with the hooks the coordinator needs around layout.
  final class TranscriptCollectionView: UICollectionView {
    /// The size is about to change: the last moment the reader's place can be
    /// read. Setting the frame moves the offset (by 166 pt on an iPad turning
    /// to landscape) and can measure rows at the new width (the layout's
    /// bounds-change invalidation), both before the next layout pass.
    var willResize: (() -> Void)?
    /// A size change that `willResize` announced ended where it started.
    var resizeDropped: (() -> Void)?
    /// Old size, new size.
    var resize: ((CGSize, CGSize) -> Void)?
    var didLayoutResize: (() -> Void)?
    var didMoveIntoWindow: (() -> Void)?
    private var laidOutSize: CGSize = .zero
    private var resizeAnnounced = false

    override var frame: CGRect {
      get { super.frame }
      set {
        noteSize(newValue.size)
        super.frame = newValue
      }
    }

    override var bounds: CGRect {
      get { super.bounds }
      set {
        noteSize(newValue.size)
        super.bounds = newValue
      }
    }

    private func noteSize(_ size: CGSize) {
      if !resizeAnnounced && size != bounds.size {
        resizeAnnounced = true
        willResize?()
      }
    }

    override func didMoveToWindow() {
      super.didMoveToWindow()
      if window != nil { didMoveIntoWindow?() }
    }

    override func layoutSubviews() {
      let old = laidOutSize
      let new = bounds.size
      // The first real size counts: rows measured before it were measured at
      // no width at all.
      let resized = old != new && new.width > 0
      laidOutSize = new
      let announced = resizeAnnounced
      resizeAnnounced = false
      // Before `super`: what the resize changes (widths, heights, the offset)
      // is then laid out in this same pass. An invalidation made after `super`
      // is not acted on until something else lays the view out.
      if resized {
        resize?(old, new)
      } else if announced {
        resizeDropped?()
      }
      super.layoutSubviews()
      // The layout pass itself can move the offset again: the anchor is put
      // back once more.
      if resized { didLayoutResize?() }
    }
  }

  /// The layout: positions from the model; rows measured before they are shown.
  ///
  /// UIKit self-sizing is not used. It asks a cell for its size again on every
  /// invalidation, applies the answer to the cell even when the layout declines
  /// it, and its answers vary between passes (by a point, or by a whole line
  /// for a reused cell), so rows on screen moved for no reason. Instead:
  ///
  /// - a row is measured once per width, synchronously, by `measure` (a SwiftUI
  ///   sizing host), before it is shown: when scrolling brings it into view
  ///   (`invalidationContext(forBoundsChange:)`, which carries the offset
  ///   correction for rows above the reader) and in the load, prepend and
  ///   resize flows (`measureVisible`);
  /// - after that, only the row itself changes its height, reporting what
  ///   SwiftUI laid out in place (`rowReported`).
  final class TranscriptCollectionLayout<ID: Hashable>: UICollectionViewLayout {
    var model = TranscriptListLayoutModel<ID>()
    /// Asked on every height change: is the reader at the bottom?
    var isPinnedToBottom: () -> Bool = { true }
    /// Measures the row at a position at `model.width`.
    var measure: (Int) -> CGFloat? = { _ in nil }
    /// The coordinator is in one of its own flows (load, prepend, resize),
    /// which put the anchor back themselves at the end. UIKit passes through
    /// intermediate offsets during them; an offset correction for a row
    /// measured there would be applied after the anchor was restored, and move
    /// the content by exactly that row's change (46 pt on an iPad, before this).
    var inFlow = false
    /// How far beyond the viewport rows are measured ahead of being shown.
    private let lookahead: CGFloat = 400

    override func prepare() {
      super.prepare()
      guard let collectionView else { return }
      let width = collectionView.bounds.width - collectionView.adjustedContentInset.left
        - collectionView.adjustedContentInset.right
      if model.width != width {
        model.setWidth(width)
      }
    }

    override var collectionViewContentSize: CGSize {
      CGSize(width: model.width, height: model.contentHeight)
    }

    // Never measures: a height that changed here would move rows the
    // collection view has already placed from an earlier query, and leave its
    // content size behind the model. Measuring happens before layout, in the
    // invalidations and flows below.
    override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
      model.positions(intersecting: rect.minY, rect.maxY).map(attributes(at:))
    }

    override func layoutAttributesForItem(at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
      indexPath.item < model.count ? attributes(at: indexPath.item) : nil
    }

    private func attributes(at position: Int) -> UICollectionViewLayoutAttributes {
      let attributes = UICollectionViewLayoutAttributes(forCellWith: IndexPath(item: position, section: 0))
      attributes.frame = model.frame(at: position)
      return attributes
    }

    // MARK: Measuring ahead of scrolling

    private func width(of bounds: CGRect) -> CGFloat {
      guard let collectionView else { return bounds.width }
      let inset = collectionView.adjustedContentInset
      return bounds.width - inset.left - inset.right
    }

    private func hasUnmeasuredRows(in bounds: CGRect) -> Bool {
      model.positions(intersecting: bounds.minY - lookahead, bounds.maxY + lookahead)
        .contains { !model.isMeasured(model.ids[$0]) }
    }

    override func shouldInvalidateLayout(forBoundsChange newBounds: CGRect) -> Bool {
      width(of: newBounds) != model.width || hasUnmeasuredRows(in: newBounds)
    }

    override func invalidationContext(forBoundsChange newBounds: CGRect) -> UICollectionViewLayoutInvalidationContext {
      let context = super.invalidationContext(forBoundsChange: newBounds)
      guard let collectionView, width(of: newBounds) == model.width else { return context }
      let before = model.contentHeight
      let adjustment = measureRows(around: newBounds, topInset: collectionView.adjustedContentInset.top)
      context.contentSizeAdjustment = CGSize(width: 0, height: model.contentHeight - before)
      if !inFlow {
        context.contentOffsetAdjustment = CGPoint(x: 0, y: adjustment)
      }
      return context
    }

    /// Measures every unmeasured row in and around `bounds`, and answers by how
    /// much the offset must move so that nothing visible moves (or, at the
    /// bottom, so that the bottom stays).
    private func measureRows(around bounds: CGRect, topInset: CGFloat) -> CGFloat {
      var adjustment: CGFloat = 0
      let pinned = isPinnedToBottom()
      // Heights change positions; a few passes settle it.
      for _ in 0..<4 {
        let window = bounds.offsetBy(dx: 0, dy: adjustment)
        let todo = model.positions(intersecting: window.minY - lookahead, window.maxY + lookahead)
          .filter { !model.isMeasured(model.ids[$0]) }
        guard !todo.isEmpty else { break }
        for position in todo {
          guard let height = measure(position) else { continue }
          let visibleTop = window.minY + topInset
          let delta = model.setHeight(height, for: model.ids[position])
          adjustment += model.offsetAdjustment(
            forRowAt: position, delta: delta, visibleTop: visibleTop, pinnedToBottom: false)
        }
      }
      if pinned, let collectionView {
        let inset = collectionView.adjustedContentInset
        let bottom = max(-inset.top, model.contentHeight + inset.bottom - bounds.height)
        return bottom - bounds.minY
      }
      return adjustment
    }

    /// Measures the rows on screen and around them now, moving the offset as
    /// the anchor rule says. For the coordinator's own flows (load, prepend,
    /// resize), which then put the anchor back exactly.
    func measureVisible() {
      guard let collectionView else { return }
      let adjustment = measureRows(around: collectionView.bounds, topInset: collectionView.adjustedContentInset.top)
      invalidateLayout()
      if adjustment != 0 {
        collectionView.contentOffset.y += adjustment
      }
    }

    // MARK: Changes the rows report

    private var reported: [ID: CGFloat] = [:]

    /// A row's own report of its height, after its content changed.
    ///
    /// It arrives from inside the collection view's layout pass (SwiftUI lays
    /// the cell out there), where an invalidation is not acted on until
    /// something else lays the view out again. So reports are collected and
    /// applied on the next turn of the main queue.
    func rowReported(_ id: ID, height: CGFloat) {
      let first = reported.isEmpty
      reported[id] = height
      guard first else { return }
      DispatchQueue.main.async { [weak self] in
        self?.applyReports()
      }
    }

    /// Applies the reports with the anchor rule done by hand: the row at the
    /// top of the viewport is taken before and put back after, to the point
    /// (or the bottom kept), rather than trusting an offset correction to land.
    private func applyReports() {
      let reports = reported
      reported = [:]
      guard let collectionView else { return }
      let inset = collectionView.adjustedContentInset
      let pinned = isPinnedToBottom()
      let anchor = pinned ? nil : model.anchor(visibleTop: collectionView.contentOffset.y + inset.top)
      var changed = false
      for (id, height) in reports {
        guard model.index[id] != nil, model.accepts(height, for: id) else { continue }
        changed = model.setHeight(height, for: id) != 0 || changed
      }
      guard changed else { return }
      invalidateLayout()
      if pinned {
        collectionView.contentOffset.y = max(-inset.top, model.contentHeight + inset.bottom - collectionView.bounds.height)
      } else if let anchor, let top = model.visibleTop(restoring: anchor) {
        collectionView.contentOffset.y = top - inset.top
      }
      collectionView.layoutIfNeeded()
    }
  }

  /// A plain cell; the layout decides its size.
  final class TranscriptHostingCell: UICollectionViewCell {
    static let reuseIdentifier = "transcript.row"
  }

  /// Owns the collection view and keeps it in step with the rows.
  @MainActor
  final class CollectionTranscriptCoordinator<Item: Identifiable & Equatable & Sendable, Row: View>: NSObject,
    UICollectionViewDataSource, UICollectionViewDelegate
  where Item.ID: Sendable {
    let state: TranscriptListState
    var row: (Item) -> Row
    let layout = TranscriptCollectionLayout<Item.ID>()
    let collectionView: TranscriptCollectionView

    private var items: [Item] = []
    private var environment = EnvironmentValues()
    private var appearance: Appearance?
    private var lastCommand = 0
    private var loaded = false
    /// Content moves we cause ourselves; scroll callbacks ignore them.
    private var applying = 0
    /// The reader is at the bottom, as of their last scroll.
    private var pinned = true

    init(state: TranscriptListState, row: @escaping (Item) -> Row) {
      self.state = state
      self.row = row
      collectionView = TranscriptCollectionView(frame: .zero, collectionViewLayout: layout)
      super.init()
      layout.isPinnedToBottom = { [unowned self] in pinned }
      layout.measure = { [unowned self] position in measureRow(at: position) }
      collectionView.backgroundColor = .clear
      collectionView.contentInsetAdjustmentBehavior = .never
      collectionView.alwaysBounceVertical = true
      collectionView.keyboardDismissMode = .interactive
      // The cells are not focus targets (the controls inside rows are). With
      // them focusable, the iPad's focus system kept asking for the first row,
      // far off screen: it was built, measured and rendered again and again.
      collectionView.allowsFocus = false
      // No prefetching: rows are measured ahead by the sizer already, and a
      // prefetched cell renders its row whether or not it is shown. In the chat
      // screen, during a reader's scroll, a row was rendered in a prefetched
      // cell and then again in the cell that showed it, with nothing changed.
      collectionView.isPrefetchingEnabled = false
      collectionView.selfSizingInvalidation = .disabled
      collectionView.accessibilityIdentifier = "transcript.list"
      collectionView.register(TranscriptHostingCell.self, forCellWithReuseIdentifier: TranscriptHostingCell.reuseIdentifier)
      collectionView.dataSource = self
      collectionView.delegate = self
      collectionView.willResize = { [unowned self] in noteReaderPlace() }
      collectionView.resizeDropped = { [unowned self] in placeBeforeResize = nil }
      collectionView.resize = { [unowned self] old, new in resize(from: old, to: new) }
      collectionView.didLayoutResize = { [unowned self] in restoreResizeAnchor() }
      collectionView.didMoveIntoWindow = { [unowned self] in
        if !loaded && !items.isEmpty && collectionView.bounds.width > 0 { load() }
      }
    }

    // MARK: Updates

    /// The appearance values that, when they change, reconfigure every row on
    /// screen. Other environment values a row reads are taken when it is
    /// configured.
    private struct Appearance: Equatable {
      var colorScheme: ColorScheme
      var dynamicTypeSize: DynamicTypeSize
      var layoutDirection: LayoutDirection
      var legibilityWeight: LegibilityWeight?
      var contrast: ColorSchemeContrast
    }

    func update(environment: EnvironmentValues) {
      self.environment = environment
      let new = Appearance(
        colorScheme: environment.colorScheme, dynamicTypeSize: environment.dynamicTypeSize,
        layoutDirection: environment.layoutDirection, legibilityWeight: environment.legibilityWeight,
        contrast: environment.colorSchemeContrast)
      if let appearance, appearance != new, loaded {
        self.appearance = new
        reconfigure(collectionView.indexPathsForVisibleItems)
      }
      appearance = new
    }

    func update(spacing: CGFloat, insets: EdgeInsets) {
      if layout.model.spacing != spacing {
        layout.model.spacing = spacing
        layout.invalidateLayout()
      }
      let new = UIEdgeInsets(top: insets.top, left: 0, bottom: insets.bottom, right: 0)
      guard collectionView.contentInset != new else { return }
      let keepBottom = pinned
      withApplying {
        collectionView.contentInset = new
        collectionView.verticalScrollIndicatorInsets = new
        if keepBottom { keepAtBottom() }
      }
    }

    /// The bottom, with the rows that come into view measured on the way.
    /// Measuring them can grow the content, and an offset the coordinator
    /// sets itself gets no correction from the layout (an iPad's bottom bar
    /// growing left the newest row 123 pt under it).
    private func keepAtBottom() {
      for _ in 0..<3 {
        scrollToBottom(animated: false)
        let before = layout.model.contentHeight
        layout.measureVisible()
        if layout.model.contentHeight == before { break }
      }
      scrollToBottom(animated: false)
    }

    func update(items newItems: [Item]) {
      let old = items
      items = newItems
      if !loaded {
        // The first rows go in once the list is in a window and has a width
        // (here, or in `resize` at its first layout): cells made before that
        // never joined the accessibility tree, so VoiceOver saw an empty list
        // until the reader scrolled.
        if collectionView.window != nil && collectionView.bounds.width > 0 { load() }
        return
      }
      if old.count == newItems.count && zip(old, newItems).allSatisfy({ $0.id == $1.id }) {
        // A delta: the same rows, some changed. Reconfigure the ones on screen.
        var changed: [IndexPath] = []
        let visible = Set(collectionView.indexPathsForVisibleItems.map(\.item))
        for position in visible where position < newItems.count && old[position] != newItems[position] {
          changed.append(IndexPath(item: position, section: 0))
        }
        if !changed.isEmpty { reconfigure(changed) }
        return
      }
      applyStructuralChange(from: old, to: newItems)
    }

    /// The first rows: measured around the bottom and shown there.
    /// `insideLayout`: called from `resize`, before the collection view's own
    /// layout pass, which then lays out what this set up.
    private func load(insideLayout: Bool = false) {
      loaded = true
      layout.model.setIDs(items.map(\.id))
      withApplying {
        let inset = collectionView.adjustedContentInset
        let width = collectionView.bounds.width - inset.left - inset.right
        if layout.model.width != width {
          layout.model.setWidth(width)
          layout.model.recompute()
        }
        collectionView.reloadData()
        if !insideLayout { collectionView.layoutIfNeeded() }
        scrollToBottom(animated: false)
        layout.measureVisible()
        scrollToBottom(animated: false)
        if !insideLayout { collectionView.layoutIfNeeded() }
      }
      updateEdges()
      announceLayoutChange()
    }

    /// Rows added, removed or replaced: insert and delete them in one batch
    /// (rows on screen keep their cells, so they are neither measured nor
    /// rendered again), and put the anchor row back. A change too large to
    /// diff cheaply reloads instead.
    private func applyStructuralChange(from old: [Item], to newItems: [Item]) {
      #if DEBUG
        let before = onScreenPositions()
        defer { TranscriptListDiagnostics.recordShift(before: before, after: onScreenPositions()) }
      #endif
      let inset = collectionView.adjustedContentInset
      let keepBottom = pinned
      let anchor = keepBottom ? nil : layout.model.anchor(visibleTop: collectionView.contentOffset.y + inset.top)
      let oldIDs = layout.model.ids
      let newIDs = newItems.map(\.id)
      let difference = newIDs.difference(from: oldIDs)
      let small = difference.insertions.count + difference.removals.count <= 600
      layout.model.setIDs(newIDs)
      withApplying {
        if small {
          var deleted: [IndexPath] = []
          var inserted: [IndexPath] = []
          for change in difference {
            switch change {
            case .remove(let offset, _, _): deleted.append(IndexPath(item: offset, section: 0))
            case .insert(let offset, _, _): inserted.append(IndexPath(item: offset, section: 0))
            }
          }
          UIView.performWithoutAnimation {
            collectionView.performBatchUpdates {
              collectionView.deleteItems(at: deleted)
              collectionView.insertItems(at: inserted)
            }
          }
          // Rows that stayed but changed, on screen: reconfigure them.
          let oldByID = Dictionary(old.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
          let changed = collectionView.indexPathsForVisibleItems.filter { indexPath in
            guard indexPath.item < newItems.count, let before = oldByID[newItems[indexPath.item].id] else { return false }
            return before != newItems[indexPath.item]
          }
          reconfigure(changed)
        } else {
          collectionView.reloadData()
        }
        if let anchor, let top = layout.model.visibleTop(restoring: anchor) {
          collectionView.contentOffset.y = top - inset.top
        }
        // Rows that come into view at the restored offset are measured before
        // they are shown; the anchor is then put back exactly.
        layout.measureVisible()
        if keepBottom {
          keepAtBottom()
        } else if let anchor, let top = layout.model.visibleTop(restoring: anchor) {
          collectionView.contentOffset.y = top - inset.top
        }
        collectionView.layoutIfNeeded()
      }
      updateEdges()
      announceLayoutChange()
    }

    #if DEBUG
      /// Where each row on screen sits in the viewport, from its cell.
      private func onScreenPositions() -> [Item.ID: CGFloat] {
        var positions: [Item.ID: CGFloat] = [:]
        let offset = collectionView.contentOffset.y
        for indexPath in collectionView.indexPathsForVisibleItems where indexPath.item < layout.model.count {
          if let cell = collectionView.cellForItem(at: indexPath) {
            positions[layout.model.ids[indexPath.item]] = cell.frame.minY - offset
          }
        }
        return positions
      }
    #endif

    /// Tells assistive technologies the rows changed: rows that appear without
    /// the reader scrolling are otherwise missing from the accessibility tree
    /// until the next scroll.
    private func announceLayoutChange() {
      // After the layout pass that places the cells, not inside it.
      DispatchQueue.main.async {
        UIAccessibility.post(notification: .layoutChanged, argument: nil)
      }
    }

    private func reconfigure(_ indexPaths: [IndexPath]) {
      guard !indexPaths.isEmpty else { return }
      collectionView.reconfigureItems(at: indexPaths)
    }

    private func withApplying(_ body: () -> Void) {
      applying += 1
      layout.inFlow = true
      body()
      applying -= 1
      layout.inFlow = applying > 0
    }

    // MARK: Resizing

    /// The list's size changed (rotation, split view, the keyboard, the first
    /// layout): the reader's row stays where it was, or the bottom stays at the
    /// bottom; at a new width every row is measured again, starting with the
    /// ones around that row.
    private func resize(from old: CGSize, to new: CGSize) {
      let noted = placeBeforeResize
      placeBeforeResize = nil
      guard loaded else {
        if collectionView.window != nil && !items.isEmpty { load(insideLayout: true) }
        return
      }
      let inset = collectionView.adjustedContentInset
      let anchor: TranscriptListLayoutModel<Item.ID>.Anchor?
      if pinned || old.width == 0 {
        anchor = nil
      } else if let noted {
        anchor = noted.anchor
      } else {
        anchor = layout.model.anchor(visibleTop: collectionView.contentOffset.y + inset.top)
      }
      resizeAnchor = anchor
      withApplying {
        let width = new.width - inset.left - inset.right
        if layout.model.width != width {
          layout.model.setWidth(width)
          layout.model.recompute()
          collectionView.reloadData()
        }
        for _ in 0..<3 {
          if pinned {
            scrollToBottom(animated: false)
          } else if let anchor, let top = layout.model.visibleTop(restoring: anchor) {
            collectionView.contentOffset.y = top - inset.top
          }
          layout.measureVisible()
        }
        if pinned {
          scrollToBottom(animated: false)
        } else if let anchor, let top = layout.model.visibleTop(restoring: anchor) {
          collectionView.contentOffset.y = top - inset.top
        }
      }
      updateEdges()
      announceLayoutChange()
    }

    /// The reader's place, read when the size was about to change.
    private struct ReaderPlace {
      let anchor: TranscriptListLayoutModel<Item.ID>.Anchor?
    }

    private var placeBeforeResize: ReaderPlace?

    /// Reads the reader's place with the offset and the heights they saw:
    /// by the time the collection view lays out at the new size, it has moved
    /// the offset and may have measured rows at the new width.
    private func noteReaderPlace() {
      guard placeBeforeResize == nil, loaded, !pinned else { return }
      let top = collectionView.contentOffset.y + collectionView.adjustedContentInset.top
      placeBeforeResize = ReaderPlace(anchor: layout.model.anchor(visibleTop: top))
    }

    /// The anchor a resize keeps, for `restoreResizeAnchor`.
    private var resizeAnchor: TranscriptListLayoutModel<Item.ID>.Anchor?

    private func restoreResizeAnchor() {
      defer { resizeAnchor = nil }
      let inset = collectionView.adjustedContentInset
      withApplying {
        if pinned {
          scrollToBottom(animated: false)
        } else if let anchor = resizeAnchor, let top = layout.model.visibleTop(restoring: anchor) {
          collectionView.contentOffset.y = top - inset.top
        }
      }
      updateEdges()
    }

    // MARK: Commands

    func perform(commandSerial: Int) {
      guard commandSerial != lastCommand else { return }
      lastCommand = commandSerial
      switch state.take() {
      case .bottom(let animated):
        pinned = true
        scrollToBottom(animated: animated)
      case .item(let id, let anchor, let animated):
        guard let id = id.base as? Item.ID, let frame = layout.model.frame(of: id) else { return }
        let inset = collectionView.adjustedContentInset
        let visible = collectionView.bounds.height - inset.top - inset.bottom
        var y = frame.minY - inset.top - anchor.y * max(0, visible - frame.height)
        y = min(max(y, -inset.top), maxOffset())
        pinned = false
        collectionView.setContentOffset(CGPoint(x: 0, y: y), animated: animated)
      case .pan(let delta):
        // A stand-in for the reader's own scrolling, so it decides `pinned` as
        // their scrolling does.
        let y = min(max(collectionView.contentOffset.y + delta, -collectionView.adjustedContentInset.top), maxOffset())
        collectionView.contentOffset.y = y
        updateEdges()
        pinned = state.isAtBottom
      case nil:
        break
      }
    }

    private func maxOffset() -> CGFloat {
      let inset = collectionView.adjustedContentInset
      return max(-inset.top, layout.model.contentHeight + inset.bottom - collectionView.bounds.height)
    }

    private func scrollToBottom(animated: Bool) {
      let target = CGPoint(x: 0, y: maxOffset())
      if animated {
        collectionView.setContentOffset(target, animated: true)
      } else {
        collectionView.contentOffset = target
      }
    }

    // MARK: Data source

    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
      items.count
    }

    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
      let cell = collectionView.dequeueReusableCell(
        withReuseIdentifier: TranscriptHostingCell.reuseIdentifier, for: indexPath)
      let content = rowContent(items[indexPath.item], reporting: true)
      cell.contentConfiguration = UIHostingConfiguration { content }
        .margins(.all, 0)
        .minSize(height: 0)
      cell.backgroundConfiguration = .clear()
      return cell
    }

    /// A row as a cell and the sizing host draw it: at its ideal height
    /// whatever height it is offered, so its size depends on the width alone,
    /// and (in a cell) reporting that height when its content changes it.
    private func rowContent(_ item: Item, reporting: Bool) -> some View {
      let id = item.id
      let layout = layout
      return RowEnvironmentBridge(captured: environment, content: TranscriptListRow(item: item, row: row).equatable())
        .fixedSize(horizontal: false, vertical: true)
        .onGeometryChange(for: CGFloat.self) { ceil($0.size.height) } action: { [weak layout] height in
          if reporting { layout?.rowReported(id, height: height) }
        }
        .frame(maxHeight: .infinity, alignment: .top)
    }

    /// Measures a row off screen, at the layout's width.
    private let sizer = UIHostingController(rootView: AnyView(EmptyView()))

    private func measureRow(at position: Int) -> CGFloat? {
      guard position < items.count, layout.model.width > 0 else { return nil }
      sizer.rootView = AnyView(rowContent(items[position], reporting: false))
      let size = sizer.sizeThatFits(in: CGSize(width: layout.model.width, height: .greatestFiniteMagnitude))
      // Hold nothing between measurements: a row left in the sizer is
      // rendered again whenever something it reads changes.
      sizer.rootView = AnyView(EmptyView())
      return size.height.isFinite ? ceil(size.height) : nil
    }

    // MARK: Scrolling

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
      guard applying == 0 else { return }
      updateEdges()
      if scrollView.isTracking || scrollView.isDecelerating || scrollView.isDragging {
        pinned = state.isAtBottom
      }
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
      if !decelerate { pinned = state.isAtBottom }
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
      pinned = state.isAtBottom
    }

    func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
      updateEdges()
      pinned = state.isAtBottom
    }

    /// At the bottom, near the top, and the row at the top.
    private func updateEdges() {
      let inset = collectionView.adjustedContentInset
      let offset = collectionView.contentOffset.y
      let visibleBottom = offset + collectionView.bounds.height - inset.bottom
      let atBottom = visibleBottom >= layout.model.contentHeight - state.bottomThreshold
      if state.isAtBottom != atBottom {
        state.isAtBottom = atBottom
      }
      let visibleTop = offset + inset.top
      let anchor = layout.model.anchor(visibleTop: visibleTop)
      state.topVisibleID = anchor.map { AnyHashable($0.id) }
      let nearTop = layout.model.contentHeight > collectionView.bounds.height && visibleTop <= state.nearTopThreshold
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
