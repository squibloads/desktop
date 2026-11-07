// A self-signed certificate for 127.0.0.1, made at test time with node:crypto alone, so no key
// or certificate is kept in the repository. Nothing trusts it by default: Node's fetch refuses it,
// and Chromium refuses it until a test tells the session to accept it.

import { generateKeyPairSync, randomBytes, sign } from "node:crypto";

// DER encodes each value as a tag, the length of its content, then the content.
function der(tag, content) {
  const length = content.length;
  let header;
  if (length < 0x80) header = Buffer.from([tag, length]);
  else if (length < 0x100) header = Buffer.from([tag, 0x81, length]);
  else header = Buffer.from([tag, 0x82, length >> 8, length & 0xff]);
  return Buffer.concat([header, content]);
}

const sequence = (...items) => der(0x30, Buffer.concat(items));
const set = (...items) => der(0x31, Buffer.concat(items));
// DER keeps an integer to its fewest bytes, so a leading zero byte is dropped, except before a byte whose top bit
// is set: there one zero keeps the value from reading as negative.
function integer(bytes) {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0 && (bytes[start + 1] & 0x80) === 0) start += 1;
  const minimal = bytes.subarray(start);
  return der(0x02, minimal[0] & 0x80 ? Buffer.concat([Buffer.from([0]), minimal]) : minimal);
}
// tests/contract/self-signed-cert.test.js checks the encoding byte by byte.
export { integer as derInteger };
const objectId = (bytes) => der(0x06, Buffer.from(bytes));
const utf8 = (text) => der(0x0c, Buffer.from(text, "utf8"));
const octets = (bytes) => der(0x04, bytes);
const bits = (bytes) => der(0x03, Buffer.concat([Buffer.from([0]), bytes]));
const explicit = (n, content) => der(0xa0 + n, content);
// UTCTime is YYMMDDHHMMSSZ.
const utcTime = (date) => der(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`));

const ECDSA_WITH_SHA256 = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];
const COMMON_NAME = [0x55, 0x04, 0x03];
const SUBJECT_ALT_NAME = [0x55, 0x1d, 0x11];
const DAY_MS = 24 * 60 * 60 * 1000;

function pem(label, body) {
  const lines = body.toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

/**
 * Returns { cert, key } as PEM strings, and certBase64: the certificate's DER as one base64 line,
 * which is how a test recognises the certificate when Electron hands it back.
 */
export function selfSignedCert() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const name = sequence(set(sequence(objectId(COMMON_NAME), utf8("127.0.0.1"))));
  const now = Date.now();
  // The address is in the subject alternative name, where Chromium and Node look for it.
  const altName = sequence(objectId(SUBJECT_ALT_NAME), octets(sequence(der(0x87, Buffer.from([127, 0, 0, 1])))));
  const serial = randomBytes(8);
  serial[0] &= 0x7f;
  const toBeSigned = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    sequence(objectId(ECDSA_WITH_SHA256)),
    name,
    sequence(utcTime(new Date(now - DAY_MS)), utcTime(new Date(now + DAY_MS))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    explicit(3, sequence(altName)),
  );
  const certificate = sequence(
    toBeSigned,
    sequence(objectId(ECDSA_WITH_SHA256)),
    bits(sign("sha256", toBeSigned, privateKey)),
  );
  return {
    cert: pem("CERTIFICATE", certificate),
    key: privateKey.export({ type: "pkcs8", format: "pem" }),
    certBase64: certificate.toString("base64"),
  };
}
