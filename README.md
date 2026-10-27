# TonePerfect MCP server

Use the [TonePerfect pronunciation assessment API](https://api.toneperfect.app) from an MCP client. Supports recordings of a known reference text in ten languages. All language packs are experimental; scored dimensions vary by language. Japanese pitch accent is not scored. Phoneme evidence is not a validated correction.

## Run locally

Requires Node.js 18 or later. From this directory:

```sh
npm ci
npm test
```

Configure your MCP client with the absolute path to the built entry point:

```json
{
  "mcpServers": {
    "toneperfect": {
      "command": "node",
      "args": ["/absolute/path/to/toneperfect-mcp/dist/index.js"],
      "env": { "TONEPERFECT_API_KEY": "YOUR_API_KEY" }
    }
  }
}
```

Get a key from the [dashboard](https://api.toneperfect.app/dashboard). Keep it in your client's secret configuration, never a public repository. For an npm installation, use `npx -y toneperfect-mcp@0.1.0` as the command (or configure `command: npx` with `args: ["-y", "toneperfect-mcp@0.1.0"]`). The package publisher is `niktoneperfect`.

## Tools

* `list_languages`: fetch current supported languages, dimensions and limitations. No key or credits required.
* `assess_pronunciation`: upload a local audio file, base64 audio, or audio downloaded from a URL, with reference text and locale. Sends that audio and reference text to TonePerfect. Only supply recordings you have permission to upload. Uses API credits.
* `explain_result`: explain a previously returned JSON result locally. No API call or credits.

Recordings must be at most 10 MB and 30 seconds. One credit is charged per started 15 seconds of assessable audio; unassessable results are not charged. New accounts currently receive 50 free credits. See [pricing](https://api.toneperfect.app/pricing/) for current terms.

The default assessment idempotency key is derived from the audio and fields: identical calls replay within the API's retention window. Set a new explicit key for an intentionally new assessment of identical input. Scores are display grades, not accuracy percentages or exam levels. Check `assessable` and the language-specific capabilities before displaying feedback.

## Desktop bundle

```sh
npm run pack:mcpb
```

This builds and validates `toneperfect.mcpb` for compatible desktop clients. It contains the server and dependencies, not your key. This is a local stdio server, not a hosted HTTP connector.

## Registry readiness

`server.json` targets `app.toneperfect/pronunciation`. Publishing requires both an available npm package and verification of the domain namespace. The file alone does not create a registry listing. The MCP registry listing requires a separate publication step; installing the npm package does not create that listing.

MIT licensed. [API reference](https://api.toneperfect.app/docs). Contact: nik@toneperfect.app.
