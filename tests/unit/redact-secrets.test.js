import { describe, it, expect } from "vitest";

const { redactSecrets } = require("../../src/main/redact-secrets.js");

const DIGEST = "ghcr.io/turnstonelabs/turnstone@sha256:c98762f1c339986d84c255476d0fe188466bb13da1ccee695612ec3a83660d12";

describe("redactSecrets", () => {
  // Failure: a value Turnstone treats as a secret reaches the error page or the log in one of the forms Podman, a
  // config file or an environment listing writes it in (L-11).
  it.each([
    ['jwt_secret = "9f2c4e"', "jwt_secret = [redacted]"],
    ["jwt_secret='9f2c4e'", "jwt_secret=[redacted]"],
    ["TURNSTONE_JWT_SECRET=9f2c4e", "TURNSTONE_JWT_SECRET=[redacted]"],
    ["TURNSTONE_OIDC_CLIENT_SECRET=s3cr3t", "TURNSTONE_OIDC_CLIENT_SECRET=[redacted]"],
    ['mcp_token_encryption_key = "Zm9vYmFy"', "mcp_token_encryption_key = [redacted]"],
    ['mcp_token_encryption_keys = ["a1", "b2"]', "mcp_token_encryption_keys = [redacted]"],
    ["api_key: sk-abc123", "api_key: [redacted]"],
    ['{"api_key":"sk-abc123","model":"m"}', '{"api_key":[redacted],"model":"m"}'],
    ["db_password=hunter2", "db_password=[redacted]"],
    ["--token=abc123", "--token=[redacted]"],
    ["Client_Secret : xyz", "Client_Secret : [redacted]"],
  ])("masks %s", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  // Failure: masking eats the image digest or ordinary text, and the error page loses what the user needs to act on.
  it("leaves digests and text without a secret key unchanged", () => {
    const text = `Error: pulling ${DIGEST}: connection reset by peer\nthe password prompt timed out`;
    expect(redactSecrets(text)).toBe(text);
  });

  // Failure: only the first secret in a multi-line stderr is masked, and a later one is shown.
  it("masks every secret in the text and keeps the lines around them", () => {
    const text = ["Error: bad config", "jwt_secret = \"aaaa\"", `image ${DIGEST}`, "api_key = bbbb"].join("\n");
    expect(redactSecrets(text)).toBe(
      ["Error: bad config", "jwt_secret = [redacted]", `image ${DIGEST}`, "api_key = [redacted]"].join("\n"),
    );
  });

  // Failure: a key at the end of a line takes the next line as its value, and a line the user needs disappears.
  it("never reaches past the end of the line for a value", () => {
    expect(redactSecrets("jwt_secret =\nError: no such pod turnstone")).toBe("jwt_secret =\nError: no such pod turnstone");
  });

  // Failure: a value survives in part, so a secret with a space, a comma or a closing bracket in it shows its tail.
  it("removes the whole value, whatever it contains", () => {
    for (const value of ['"a b,c]d"', "'x y'", '["k1","k2 k3"]', "plain;tail,more"]) {
      const out = redactSecrets(`jwt_secret = ${value}`);
      expect(out).toBe("jwt_secret = [redacted]");
    }
  });

  // The cost of the generic rule, pinned so a change to it is a decision: a harmless number under a key that names a
  // token is masked too.
  it("masks any key whose name contains password, token or secret, including harmless ones", () => {
    expect(redactSecrets("max_tokens: 4096")).toBe("max_tokens: [redacted]");
  });

  // Failure: a non-string detail, such as an exit code, throws inside the error path and hides the real failure.
  it("turns a non-string into text", () => {
    expect(redactSecrets(125)).toBe("125");
  });
});
