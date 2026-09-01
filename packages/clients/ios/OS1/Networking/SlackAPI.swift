import Foundation

@MainActor
enum SlackAPI {
    struct Channel: Decodable, Sendable, Identifiable, Hashable {
        let id: String
        let name: String
    }

    struct ChannelsResponse: Decodable, Sendable {
        let channels: [Channel]
        let defaultChannel: String?
        let canUploadImages: Bool?
    }

    struct ShippedChangeResponse: Decodable, Sendable {
        let status: String
    }

    struct ComposerResponse: Decodable, Sendable {
        let status: String
        let channel: Channel?
        let permalink: String?
        /// Optional for compatibility with servers predating sent-message Undo.
        let ts: String?
    }

    private struct UploadResponse: Decodable, Sendable {
        let ok: Bool
        let path: String?
        let error: String?
    }

    private struct ErrorResponse: Decodable, Sendable {
        let error: String?
    }

    /// Configured Slack destinations for deliberate, human-authored posts.
    static func channels(sessionId: String) async throws -> ChannelsResponse {
        let session = encodePath(sessionId)
        let data = try await request("/api/sessions/\(session)/slack-composer")
        return try JSONDecoder().decode(ChannelsResponse.self, from: data)
    }

    /// Post through the signed-in person's Slack grant. The server refuses to
    /// fall back to its bot identity, so success always means it appeared as them.
    static func post(channelId: String, text: String) async throws {
        let encoded = channelId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? channelId
        _ = try await request(
            "/api/slack/channels/\(encoded)/messages",
            method: "POST",
            body: ["text": text]
        )
    }

    static func shippedChangeChannels(sessionId: String) async throws -> ChannelsResponse {
        let session = encodePath(sessionId)
        let data = try await request("/api/sessions/\(session)/share-shipped-change")
        return try JSONDecoder().decode(ChannelsResponse.self, from: data)
    }

    static func uploadImage(_ image: AttachedImage, index: Int) async throws -> String {
        let config = ServerConfig.shared
        guard let base = config.baseURL, config.isConfigured else {
            throw OS1API.APIError.notConfigured
        }
        guard let url = URL(string: base.absoluteString + "/api/upload") else {
            throw OS1API.APIError.badURL
        }
        var request = config.authorizedRequest(url)
        request.httpMethod = "POST"
        request.setValue(image.mediaType, forHTTPHeaderField: "Content-Type")
        request.setValue("slack-image-\(index).jpg", forHTTPHeaderField: "x-file-name")
        request.httpBody = image.jpegData
        let (data, response) = try await URLSession.shared.data(for: request)
        let body = try? JSONDecoder().decode(UploadResponse.self, from: data)
        if let http = response as? HTTPURLResponse,
           !(200..<300).contains(http.statusCode) {
            if let message = body?.error { throw OS1API.APIError.server(message) }
            throw OS1API.APIError.http(http.statusCode)
        }
        guard body?.ok == true, let path = body?.path else {
            throw OS1API.APIError.server(body?.error ?? "Couldn't add that image")
        }
        return path
    }

    static func shareShippedChange(
        sessionId: String,
        repo: String?,
        branch: String?,
        channelId: String,
        message: String,
        screenshots: [String]
    ) async throws -> ShippedChangeResponse {
        var body: [String: Any] = [
            "channel": channelId,
            "message": message,
            "screenshots": screenshots,
        ]
        if let repo, !repo.isEmpty { body["repo"] = repo }
        if let branch, !branch.isEmpty { body["branch"] = branch }
        let session = encodePath(sessionId)
        let data = try await request(
            "/api/sessions/\(session)/share-shipped-change",
            method: "POST",
            body: body
        )
        return try JSONDecoder().decode(ShippedChangeResponse.self, from: data)
    }

    static func updateComposer(
        sessionId: String,
        requestId: String,
        channelId: String,
        message: String,
        screenshots: [String]
    ) async throws {
        guard let connection = ServerConfig.shared.connection else {
            throw OS1API.APIError.notConfigured
        }
        let request = try composerDraftRequest(
            connection: connection,
            sessionId: sessionId,
            requestId: requestId,
            channelId: channelId,
            message: message,
            screenshots: screenshots
        )
        _ = try await response(for: request)
    }

    nonisolated static func composerDraftRequest(
        connection: ServerConnection,
        sessionId: String,
        requestId: String,
        channelId: String,
        message: String,
        screenshots: [String]
    ) throws -> URLRequest {
        let session = encodePath(sessionId)
        guard let url = URL(
            string: connection.baseURL.absoluteString
                + "/api/sessions/\(session)/slack-composer"
        ) else {
            throw OS1API.APIError.badURL
        }
        var request = connection.authorizedRequest(url)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "requestId": requestId,
            "channel": channelId,
            "message": message,
            "screenshots": screenshots,
        ])
        return request
    }

    static func sendComposer(
        sessionId: String,
        requestId: String,
        channelId: String,
        message: String,
        screenshots: [String]
    ) async throws -> ComposerResponse {
        let session = encodePath(sessionId)
        let data = try await request(
            "/api/sessions/\(session)/slack-composer",
            method: "POST",
            body: [
                "requestId": requestId,
                "channel": channelId,
                "message": message,
                "screenshots": screenshots,
            ]
        )
        return try JSONDecoder().decode(ComposerResponse.self, from: data)
    }

    static func undoComposer(sessionId: String, channelId: String, ts: String) async throws {
        let session = encodePath(sessionId)
        _ = try await request(
            "/api/sessions/\(session)/slack-composer/undo",
            method: "POST",
            body: ["channel": channelId, "ts": ts]
        )
    }

    static func cancelComposer(sessionId: String, requestId: String) async throws {
        let session = encodePath(sessionId)
        _ = try await request(
            "/api/sessions/\(session)/slack-composer",
            method: "DELETE",
            body: ["requestId": requestId]
        )
    }

    nonisolated private static func encodePath(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }

    private static func request(
        _ path: String,
        method: String = "GET",
        body: [String: Any]? = nil
    ) async throws -> Data {
        let config = ServerConfig.shared
        guard let base = config.baseURL, config.isConfigured else {
            throw OS1API.APIError.notConfigured
        }
        guard let url = URL(string: base.absoluteString + path) else {
            throw OS1API.APIError.badURL
        }
        var request = config.authorizedRequest(url)
        request.httpMethod = method
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return try await response(for: request)
    }

    private static func response(for request: URLRequest) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse,
           !(200..<300).contains(http.statusCode) {
            if let errorBody = try? JSONDecoder().decode(ErrorResponse.self, from: data),
               let message = errorBody.error {
                throw OS1API.APIError.server(message)
            }
            throw OS1API.APIError.http(http.statusCode)
        }
        return data
    }
}
