import ExpoModulesCore

/**
 One view, and a probe for whether this binary has it.

 There is no module-level function here on purpose: a drop belongs to a REGION of the window — the
 chat, and not the sidebar beside it — so the whole of this module is a view the call site wraps
 around what should accept a file. `HermieDropView` is where everything happens.

 `supportsFileDrop` exists only so JavaScript can ask the module rather than asking for the view:
 `requireNativeView` throws for a view that is not registered, and a binary installed over a newer
 bundle is exactly the case that would hit it. See `src/platform/file-drop.tsx`.
 */
public class HermieDropModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HermieDrop")

    Function("supportsFileDrop") { () -> Bool in
      true
    }

    View(HermieDropView.self) {
      Events("onDrop", "onDropEnter", "onDropExit")

      Prop("enabled") { (view: HermieDropView, enabled: Bool?) in
        view.setEnabled(enabled ?? true)
      }
    }
  }
}
