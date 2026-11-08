// Masks secret values in text the app is about to show or log (L-11). The secrets #1680 makes never leave the machine,
// so the app never holds a value to match: it masks by key name instead. That makes it a net for any later call whose
// stderr or command line could carry a secret, such as a model key from the wizard or an environment listing.
//
// No electron here, so the rule runs under plain Node in the unit tier.

// The keys Turnstone reads secrets from, then any key whose name says it holds one. The generic rule over-masks a
// harmless value now and then (max_tokens), which costs a number on an error page; under-masking would cost a secret.
const SECRET_KEY = String.raw`jwt_secret|mcp_token_encryption_keys?|api_key|turnstone_jwt_secret|turnstone_oidc_client_secret|\w*(?:password|token|secret)\w*`;

// key = value, key: value, KEY=value, and "key": value in JSON. The value is a TOML array, a quoted string or the rest
// of the word, never past the end of the line, so a key with nothing after it cannot take the next line.
const SECRET_VALUE = new RegExp(
  String.raw`\b(${SECRET_KEY})(["']?[ \t]*[:=][ \t]*)(\[[^\]\n]*\]|"(?:[^"\\\n]|\\.)*"|'[^'\n]*'|\S+)`,
  "gi",
);

/** The text with each secret value replaced by [redacted]; the keys and everything else are kept. */
function redactSecrets(text) {
  return String(text).replace(SECRET_VALUE, (_match, key, separator) => `${key}${separator}[redacted]`);
}

module.exports = { redactSecrets };
