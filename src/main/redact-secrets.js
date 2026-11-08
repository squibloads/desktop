// Masks secret values in text the app is about to show or log (L-11). The secrets #1680 makes never leave the machine,
// so the app never holds a value to match: it masks by key name instead. That makes it a net for any later call whose
// stderr or command line could carry a secret, such as a model key from the wizard or an environment listing.
//
// No electron here, so the rule runs under plain Node in the unit tier.

// The keys Turnstone reads secrets from, then any key whose name says it holds one, whatever word characters and
// hyphens surround it (OPENAI_API_KEY, --api-key, x-client-secret-value). The generic rule over-masks a harmless value
// now and then (max_tokens), which costs a number on an error page; under-masking would cost a secret. Its bounds keep
// a long run of hyphenated words from backtracking without limit.
const SECRET_KEY = String.raw`jwt_secret|mcp_token_encryption_keys?|turnstone_jwt_secret|turnstone_oidc_client_secret|[\w-]{0,64}(?:password|token|secret|api[_-]?key)[\w-]{0,64}`;

// A TOML or JSON array read entry by entry, so a bracket inside a quoted entry does not end it; an array the line cuts
// off is masked to the end of the line.
const ARRAY = String.raw`\[(?:"(?:[^"\\\n]|\\.)*"|'[^'\n]*'|[^\]"'\n])*\]|\[[^\n]*`;

// key = value, key: value, KEY=value, and "key": value in JSON. The value is an array, a quoted string or the rest of
// the word, never past the end of the line, so a key with nothing after it cannot take the next line. Both parts are
// fixed text above; nothing from the input is built into the pattern.
const SECRET_VALUE = new RegExp(
  String.raw`\b(${SECRET_KEY})(["']?[ \t]*[:=][ \t]*)(${ARRAY}|"(?:[^"\\\n]|\\.)*"|'[^'\n]*'|\S+)`,
  "gi",
);

/** The text with each secret value replaced by [redacted]; the keys and everything else are kept. */
function redactSecrets(text) {
  return String(text).replace(SECRET_VALUE, (_match, key, separator) => `${key}${separator}[redacted]`);
}

module.exports = { redactSecrets };
