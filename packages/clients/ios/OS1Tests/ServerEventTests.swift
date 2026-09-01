import XCTest
@testable import OS1

/// Wire-format tests: raw server JSON frames → `ServerEvent.parse`. These pin
/// the protocol contract with the backstage server (ws-handlers.ts), so a
/// field rename on either side fails here instead of silently decoding to
/// `.ignored` in production.
final class ServerEventTests: XCTestCase {
    private func parse(_ json: String) -> ServerEvent {
        ServerEvent.parse(Data(json.utf8))
    }

    func testHello() {
        guard case .hello(let bootId) = parse(#"{"type":"hello","bootId":"boot-1"}"#) else {
            return XCTFail("expected .hello")
        }
        XCTAssertEqual(bootId, "boot-1")
    }

    func testServerRestarting() {
        guard case .serverRestarting = parse(#"{"type":"server_restarting"}"#) else {
            return XCTFail("expected .serverRestarting")
        }
    }

    func testPong() {
        guard case .pong = parse(#"{"type":"pong"}"#) else {
            return XCTFail("expected .pong")
        }
    }

    func testPresenceDecodesViewers() {
        let json = #"{"type":"presence","sessionId":"bks-1","viewers":["Kent","Michiel"]}"#
        guard case .presence(let id, let viewers) = parse(json) else {
            return XCTFail("expected .presence")
        }
        XCTAssertEqual(id, "bks-1")
        XCTAssertEqual(viewers, ["Kent", "Michiel"])
    }

    func testTypingDecodesUsers() {
        let json = #"{"type":"typing","sessionId":"bks-1","users":["Grant","Kent"]}"#
        guard case .typing(let id, let users) = parse(json) else {
            return XCTFail("expected .typing")
        }
        XCTAssertEqual(id, "bks-1")
        XCTAssertEqual(users, ["Grant", "Kent"])
    }

    /// Everyone left: the frame still arrives, with an empty list.
    func testPresenceWithNoViewers() {
        guard case .presence(_, let viewers) =
            parse(#"{"type":"presence","sessionId":"bks-1","viewers":[]}"#)
        else {
            return XCTFail("expected .presence")
        }
        XCTAssertTrue(viewers.isEmpty)
    }

    func testTranscriptInitDecodesEntries() {
        let json = #"""
        {"type":"transcript_init","sessionId":"bks-1","entries":[
          {"id":"e1","type":"user","content":"hi","timestamp":"2026-07-23T10:00:00Z"},
          {"id":"e2","type":"assistant","content":"hello","model":"claude"},
          {"id":"e3","type":"tool_use","toolName":"bash","toolUseId":"tu-1",
           "toolInput":{"command":"ls","timeout":5}},
          {"id":"tr-tu-1","type":"tool_result","toolUseId":"tu-1","content":"ok","isError":false}
        ]}
        """#
        guard case .transcriptInit(let id, let entries, _) = parse(json) else {
            return XCTFail("expected .transcriptInit")
        }
        XCTAssertEqual(id, "bks-1")
        XCTAssertEqual(entries.count, 4)
        XCTAssertTrue(entries[0].isUser)
        XCTAssertEqual(entries[0].text, "hi")
        XCTAssertNotNil(entries[0].timestampDate)
        XCTAssertTrue(entries[1].isAssistant)
        XCTAssertEqual(entries[2].toolName, "bash")
        XCTAssertEqual(entries[2].toolInput?["command"]?.stringValue, "ls")
        XCTAssertEqual(entries[3].toolUseId, "tu-1")
        XCTAssertEqual(entries[3].isError, false)
    }

    func testTranscriptResumeCursorsDecode() {
        guard case .transcriptInit(_, _, let seq) = parse(#"{"type":"transcript_init","sessionId":"bks-1","entries":[],"truncated":true,"firstSeq":9,"lastSeq":140,"lastChangeSeq":151,"v2":true}"#) else {
            return XCTFail("expected seq transcript init")
        }
        XCTAssertEqual(seq.firstSeq, 9)
        XCTAssertEqual(seq.lastSeq, 140)
        XCTAssertEqual(seq.lastChangeSeq, 151)
        XCTAssertTrue(seq.v2)

        guard case .transcriptAppend(_, _, let offset) = parse(#"{"type":"transcript_append","sessionId":"bks-1","entries":[],"endOffset":8192,"rev":"rev-1"}"#) else {
            return XCTFail("expected legacy transcript append")
        }
        XCTAssertEqual(offset.endOffset, 8_192)
        XCTAssertEqual(offset.rev, "rev-1")
        XCTAssertFalse(offset.v2)
    }

    func testTranscriptFramesWithoutSessionIdAreIgnored() {
        for type in ["transcript_init", "transcript_history", "transcript_append",
                     "stream_start", "stream_done", "session_status", "queue_update"] {
            guard case .ignored = parse(#"{"type":"\#(type)"}"#) else {
                return XCTFail("\(type) without sessionId should be .ignored")
            }
        }
    }

    func testStreamText() {
        guard case .streamText(let id, let text, _) =
            parse(#"{"type":"stream_text","sessionId":"bks-1","text":"chunk"}"#)
        else { return XCTFail("expected .streamText") }
        XCTAssertEqual(id, "bks-1")
        XCTAssertEqual(text, "chunk")
        guard case .ignored = parse(#"{"type":"stream_text","sessionId":"bks-1"}"#) else {
            return XCTFail("stream_text without text should be .ignored")
        }
    }

    func testStreamToolFramesBecomeStreamEntry() {
        let json = #"""
        {"type":"stream_tool_use","sessionId":"bks-1",
         "entry":{"id":"e9","type":"tool_use","toolName":"read","toolUseId":"tu-9"}}
        """#
        guard case .streamEntry(let id, let entry) = parse(json) else {
            return XCTFail("expected .streamEntry")
        }
        XCTAssertEqual(id, "bks-1")
        XCTAssertEqual(entry.toolUseId, "tu-9")
    }

    func testSessionStatus() {
        guard case .sessionStatus(_, let running, let safety) =
            parse(#"{"type":"session_status","sessionId":"bks-1","isRunning":true}"#)
        else { return XCTFail("expected .sessionStatus") }
        XCTAssertTrue(running)
        XCTAssertNil(safety)
        // Missing isRunning defaults to false rather than failing the frame.
        guard case .sessionStatus(_, let defaulted, _) =
            parse(#"{"type":"session_status","sessionId":"bks-1"}"#)
        else { return XCTFail("expected .sessionStatus") }
        XCTAssertFalse(defaulted)

        let paused = #"{"type":"session_status","sessionId":"bks-1","isRunning":true,"safety":{"status":"paused_for_safety","explanation":"This session was paused safely.","automaticReconciliationRunning":false,"pausedAt":"2026-08-26T12:00:00Z","operation":"finishing the current turn","repairAvailable":true}}"#
        guard case .sessionStatus(_, let staleRunning, let pausedSafety) = parse(paused) else {
            return XCTFail("expected paused .sessionStatus")
        }
        XCTAssertTrue(staleRunning)
        XCTAssertEqual(pausedSafety?.status, "paused_for_safety")
        XCTAssertEqual(pausedSafety?.repairAvailable, true)
    }

    func testQueueUpdate() {
        let json = #"""
        {"type":"queue_update","sessionId":"bks-1",
         "queued":[{"id":"q1","content":"do this","user":"jaap"},{}],
         "steered":[{"id":"s1","content":"steer"}],
         "pendingDeliveryIds":["sent-1"]}
        """#
        guard case .queueUpdate(_, let queued, let steered, let pendingIds) = parse(json) else {
            return XCTFail("expected .queueUpdate")
        }
        XCTAssertEqual(queued.count, 2)
        XCTAssertEqual(queued[0].content, "do this")
        XCTAssertEqual(queued[0].user, "jaap")
        // Empty wire item still yields a usable row (generated id, empty content).
        XCTAssertFalse(queued[1].id.isEmpty)
        XCTAssertEqual(queued[1].content, "")
        XCTAssertEqual(steered.map(\.id), ["s1"])
        XCTAssertEqual(pendingIds, ["sent-1"])

        guard case .queueUpdate(_, _, _, let legacyPending) = parse(
            #"{"type":"queue_update","sessionId":"bks-1","queued":[],"steered":[]}"#
        ) else { return XCTFail("expected legacy .queueUpdate") }
        XCTAssertTrue(legacyPending.isEmpty)
    }

    func testAskQuestionAndResolved() {
        let json = #"""
        {"type":"ask_question","sessionId":"bks-1","questionId":"ask-1","questions":[
          {"question":"Merge?","header":"PR","multiSelect":false,
           "options":[{"label":"Yes","description":"ship it"},{"label":"No"}]}
        ]}
        """#
        guard case .askQuestion(let id, let question) = parse(json) else {
            return XCTFail("expected .askQuestion")
        }
        XCTAssertEqual(id, "bks-1")
        XCTAssertEqual(question.id, "ask-1")
        XCTAssertEqual(question.questions.first?.options?.count, 2)

        guard case .askResolved(_, let questionId) =
            parse(#"{"type":"ask_resolved","sessionId":"bks-1","questionId":"ask-1"}"#)
        else { return XCTFail("expected .askResolved") }
        XCTAssertEqual(questionId, "ask-1")
    }

    func testReplySuggestionsDecodeAndNullClears() {
        let json = #"{"type":"reply_suggestions","sessionId":"bks-1","suggestions":[{"label":"Fix both","text":"Fix both issues, then run the tests."},{"label":"Only cache","text":"Fix only the stale cache read."}]}"#
        guard case .replySuggestions(let id, let suggestions) = parse(json) else {
            return XCTFail("expected .replySuggestions")
        }
        XCTAssertEqual(id, "bks-1")
        XCTAssertEqual(suggestions.map(\.label), ["Fix both", "Only cache"])
        XCTAssertEqual(suggestions.first?.text, "Fix both issues, then run the tests.")

        guard case .replySuggestions(_, let cleared) =
            parse(#"{"type":"reply_suggestions","sessionId":"bks-1","suggestions":null}"#)
        else { return XCTFail("expected a clear event") }
        XCTAssertTrue(cleared.isEmpty)

        guard case .ignored = parse(#"{"type":"reply_suggestions","suggestions":[]}"#) else {
            return XCTFail("reply_suggestions without sessionId should be .ignored")
        }
    }

    func testSlackComposerSentReceiptDecodesDestinationPermalinkAndTimestamp() {
        let json = #"{"type":"slack_composer_resolved","sessionId":"bks-1","requestId":"slack-1","status":"sent","channel":{"id":"C123","name":"shipping"},"permalink":"https://tella.slack.com/archives/C123/p1700000000000000","ts":"1700000000.000000"}"#
        guard case .slackComposerResolved(let sessionId, let receipt) = parse(json) else {
            return XCTFail("expected .slackComposerResolved")
        }
        XCTAssertEqual(sessionId, "bks-1")
        XCTAssertEqual(receipt.requestId, "slack-1")
        XCTAssertEqual(receipt.status, .sent)
        XCTAssertEqual(receipt.channel, .init(id: "C123", name: "shipping"))
        XCTAssertEqual(
            receipt.permalink,
            "https://tella.slack.com/archives/C123/p1700000000000000"
        )
        XCTAssertEqual(receipt.ts, "1700000000.000000")
    }

    func testOlderSlackComposerSentReceiptDecodesWithoutTimestamp() {
        guard case .slackComposerResolved(_, let receipt) = parse(
            #"{"type":"slack_composer_resolved","sessionId":"bks-1","requestId":"slack-old","status":"sent","channel":{"id":"C123","name":"shipping"}}"#
        ) else {
            return XCTFail("expected .slackComposerResolved")
        }
        XCTAssertNil(receipt.ts)
    }

    func testSlackComposerCancelledReceiptDecodesWithoutDestination() {
        guard case .slackComposerResolved(_, let receipt) = parse(
            #"{"type":"slack_composer_resolved","sessionId":"bks-1","requestId":"slack-2","status":"cancelled"}"#
        ) else {
            return XCTFail("expected .slackComposerResolved")
        }
        XCTAssertEqual(receipt.status, .cancelled)
        XCTAssertNil(receipt.channel)
        XCTAssertNil(receipt.permalink)
    }

    func testSessionNotesDecodeAndADeletedNoteCarriesItsId() {
        let note = #"{"type":"session_note","sessionId":"bks-1","note":{"id":"note-1","user":"Kent","text":"Check this","ts":1760000000000}}"#
        guard case .sessionNote(let sessionId, let decoded) = parse(note) else {
            return XCTFail("expected .sessionNote")
        }
        XCTAssertEqual(sessionId, "bks-1")
        XCTAssertEqual(decoded.id, "note-1")
        XCTAssertEqual(decoded.user, "Kent")
        XCTAssertEqual(decoded.text, "Check this")
        XCTAssertEqual(decoded.ts, 1_760_000_000_000)

        guard case .sessionNoteDeleted(let deletedSession, let noteId) =
            parse(#"{"type":"session_note_deleted","sessionId":"bks-1","noteId":"note-1"}"#)
        else { return XCTFail("expected .sessionNoteDeleted") }
        XCTAssertEqual(deletedSession, "bks-1")
        XCTAssertEqual(noteId, "note-1")
    }

    func testMentionAndMentionClearFrames() {
        let json = #"{"type":"mention","user":"Michiel","mention":{"sessionId":"os-1","by":"Kent","source":"note","preview":"Please look","ts":1760000000000}}"#
        guard case .mention(let user, let mention) = parse(json) else {
            return XCTFail("expected .mention")
        }
        XCTAssertEqual(user, "Michiel")
        XCTAssertEqual(mention.sessionId, "os-1")
        XCTAssertEqual(mention.by, "Kent")

        guard case .mentionsCleared(let oneUser, let sessionId) =
            parse(#"{"type":"mentions_cleared","user":"Michiel","sessionId":"os-1"}"#)
        else { return XCTFail("expected one-session .mentionsCleared") }
        XCTAssertEqual(oneUser, "Michiel")
        XCTAssertEqual(sessionId, "os-1")

        guard case .mentionsCleared(let allUser, let allSessionId) =
            parse(#"{"type":"mentions_cleared","user":"Michiel"}"#)
        else { return XCTFail("expected all-session .mentionsCleared") }
        XCTAssertEqual(allUser, "Michiel")
        XCTAssertNil(allSessionId)
    }

    func testWorkflowAndGitRefreshFrames() {
        let workflow = #"{"type":"workflow_update","sessionId":"os-1","run":{"runId":"run-1","name":"Audit","status":"running","agents":[]}}"#
        guard case .workflowUpdate(let sessionId, let run) = parse(workflow) else {
            return XCTFail("expected .workflowUpdate")
        }
        XCTAssertEqual(sessionId, "os-1")
        XCTAssertEqual(run.runId, "run-1")
        XCTAssertEqual(run.name, "Audit")
        XCTAssertEqual(run.status, .running)

        guard case .gitPushed(let pushedSession, let repo) = parse(
            #"{"type":"git_pushed","sessionId":"os-1","repo":"opensession"}"#
        ) else { return XCTFail("expected .gitPushed") }
        XCTAssertEqual(pushedSession, "os-1")
        XCTAssertEqual(repo, "opensession")

        guard case .prUpdated(let updatedRepo, let branch) = parse(
            #"{"type":"pr_updated","repo":"tella-fusion","branch":"feature/native"}"#
        ) else { return XCTFail("expected .prUpdated") }
        XCTAssertEqual(updatedRepo, "tella-fusion")
        XCTAssertEqual(branch, "feature/native")
    }

    func testMalformedLiveRefreshFramesAreIgnored() {
        for json in [
            #"{"type":"workflow_update","sessionId":"os-1"}"#,
            #"{"type":"git_pushed"}"#,
            #"{"type":"pr_updated","repo":"opensession"}"#,
        ] {
            guard case .ignored = parse(json) else {
                return XCTFail("incomplete live refresh frame should be ignored")
            }
        }
    }

    func testNoticeAndError() {
        guard case .notice(let message) = parse(#"{"type":"notice","message":"heads up"}"#) else {
            return XCTFail("expected .notice")
        }
        XCTAssertEqual(message, "heads up")
        guard case .serverError(let error) = parse(#"{"type":"error"}"#) else {
            return XCTFail("expected .serverError")
        }
        XCTAssertEqual(error, "Unknown server error")
    }

    /// `usage_update` arrives two ways: run-session.ts addresses it to a
    /// session, session-create.ts emits it on a socket already scoped to the
    /// session being created and sends no id. Both are ours.
    func testUsageUpdate() {
        let addressed = #"""
        {"type":"usage_update","sessionId":"os-1","usage":{"costUsd":0.42,"inputTokens":900,"outputTokens":2500,"cacheReadTokens":45300,"cacheCreationTokens":1200,"contextTokens":128400,"contextWindow":200000,"turns":3,"updatedAt":"2026-08-13T10:00:00Z"}}
        """#
        guard case .usageUpdate(let id, let usage) = parse(addressed) else {
            return XCTFail("expected .usageUpdate")
        }
        XCTAssertEqual(id, "os-1")
        XCTAssertEqual(usage.turns, 3)
        XCTAssertEqual(usage.contextTokens, 128_400)
        XCTAssertEqual(usage.costUsd, 0.42, accuracy: 0.0001)

        guard case .usageUpdate(let noId, let creating) =
            parse(#"{"type":"usage_update","usage":{"turns":1}}"#)
        else { return XCTFail("expected .usageUpdate without a session id") }
        XCTAssertNil(noId)
        XCTAssertEqual(creating.turns, 1)
        XCTAssertEqual(creating.costUsd, 0)

        // No usage at all is nothing to render — and would otherwise blank a
        // total the session already knows.
        guard case .ignored = parse(#"{"type":"usage_update","sessionId":"os-1"}"#) else {
            return XCTFail("a usage_update with no usage must be ignored")
        }
    }

    func testUnknownAndMalformedFramesAreIgnored() {
        guard case .ignored = parse(#"{"type":"future_frame","payload":123}"#) else {
            return XCTFail("unknown frame types must decode to .ignored")
        }
        guard case .ignored = parse("not json at all") else {
            return XCTFail("malformed frames must decode to .ignored")
        }
    }
}
