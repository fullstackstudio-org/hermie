#if os(macOS)
import Darwin

/// This test process's children, read from the kernel (`libproc`), for the
/// harness's own check that it leaves none behind.
enum ChildProcesses {
  /// The PIDs whose parent is this process right now.
  static func ofThisProcess() -> [pid_t] {
    var pids = [pid_t](repeating: 0, count: 1_024)
    let count = pids.withUnsafeMutableBytes { buffer in
      proc_listchildpids(getpid(), buffer.baseAddress, Int32(buffer.count))
    }

    return count > 0 ? Array(pids.prefix(Int(count))).filter { $0 > 0 } : []
  }

  /// The children running `node`: every fake gateway this process has started and not yet reaped.
  static func nodeChildren() -> Set<pid_t> {
    Set(ofThisProcess().filter { executableName(of: $0) == "node" })
  }

  /// The last path component of a process's executable; empty when it is gone.
  static func executableName(of pid: pid_t) -> String {
    var path = [UInt8](repeating: 0, count: 4 * Int(MAXPATHLEN))
    let length = path.withUnsafeMutableBytes { buffer in
      proc_pidpath(pid, buffer.baseAddress, UInt32(buffer.count))
    }

    guard length > 0 else {
      return ""
    }

    let full = String(decoding: path.prefix(Int(length)), as: UTF8.self)
    return full.split(separator: "/").last.map(String.init) ?? ""
  }

  /// Is there still a process with this PID (zombie included)?
  static func exists(_ pid: pid_t) -> Bool {
    Darwin.kill(pid, 0) == 0 || errno == EPERM
  }
}
#endif
