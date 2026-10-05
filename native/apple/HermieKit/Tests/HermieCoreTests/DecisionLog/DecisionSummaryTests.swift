import Foundation
import Testing

@testable import HermieCore

/// What an entry says about a request, and the rule that a sensitive one says nothing.
@Suite("Decision log: summaries") struct DecisionSummaryTests {
  @Test("an approval's summary is its command's first line")
  func firstLine() {
    #expect(DecisionSummary.approval(command: "rm -rf ./build\necho done") == "rm -rf ./build")
    #expect(DecisionSummary.approval(command: "\n\n  ls -la  \nsecond") == "ls -la")
    #expect(DecisionSummary.approval(command: "echo one\r\necho two") == "echo one")
  }

  @Test("a long first line is cut to the limit with an ellipsis")
  func truncated() throws {
    let long = String(repeating: "x", count: 500)
    let summary = try #require(DecisionSummary.approval(command: long))

    #expect(summary.count == DecisionSummary.limit + 1)
    #expect(summary.hasSuffix("…"))
    #expect(summary.hasPrefix(String(repeating: "x", count: DecisionSummary.limit)))
  }

  @Test("an empty command has no summary")
  func empty() {
    #expect(DecisionSummary.approval(command: "") == nil)
    #expect(DecisionSummary.approval(command: " \n \n") == nil)
  }

  @Test("control and direction characters are not kept")
  func cleaned() {
    #expect(DecisionSummary.approval(command: "echo\u{202E} hi\u{0007}there") == "echo hithere")
  }

  @Test(
    "a command that looks like it carries a secret has no summary at all",
    arguments: [
      "export API_TOKEN=tok-9a8b7c6d",
      "curl -H 'Authorization: Bearer abc.def.ghi' https://example.com",
      "mysql -u root --password=hunter2",
      "echo $GITHUB_SECRET | gh auth login",
      "git clone https://user:hunter2@example.com/repo.git",
      "export KEY=sk-abcdefghijklmnopqrstuvwxyz",
      "gh auth login --with-token ghp_abcdefghijklmnop",
      "aws configure set aws_access_key_id AKIAABCDEFGHIJKLMNOP",
      "cat id_rsa # -----BEGIN OPENSSH PRIVATE KEY-----",
      "ssh --passphrase foo host"
    ])
  func sensitiveCommands(command: String) {
    #expect(DecisionSummary.approval(command: command) == nil)
  }

  @Test("a secret on a later line keeps the whole command out, not only the line with it")
  func laterLine() {
    #expect(DecisionSummary.approval(command: "deploy --prod\nexport TOKEN=abc123") == nil)
  }

  @Test("a request the gateway or the tool marks as sensitive has no summary whatever the command says")
  func marked() {
    #expect(DecisionSummary.approval(command: "ls", flaggedSensitive: true) == nil)
    #expect(DecisionSummary.approval(command: "ls", toolName: "vault_get") == nil)
    #expect(DecisionSummary.approval(command: "ls", toolName: "terminal") == "ls")
  }

  @Test("an ordinary command is kept")
  func ordinary() {
    #expect(DecisionSummary.approval(command: "npm test -- --watch=false") == "npm test -- --watch=false")
    #expect(DecisionSummary.approval(command: "git push origin main") == "git push origin main")
  }

  @Test("a connector's name is cleaned and cut")
  func connectorName() {
    #expect(DecisionSummary.name("calendar") == "calendar")
    #expect(DecisionSummary.name("  ") == nil)
    #expect(DecisionSummary.name(String(repeating: "n", count: 400))?.count == DecisionSummary.limit + 1)
  }
}
