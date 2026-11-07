import { X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import { derInteger, selfSignedCert } from "../helpers/self-signed-cert.js";

describe("the test certificate", () => {
  // Failure: an integer keeps a leading zero byte that DER forbids, so OpenSSL refuses about one certificate in
  // 256 and the e2e trust test fails at random.
  it("encodes each integer in the fewest bytes DER allows", () => {
    expect(derInteger(Buffer.from([0x00, 0x01])).toString("hex")).toBe("020101");
    expect(derInteger(Buffer.from([0x00, 0x00, 0x80])).toString("hex")).toBe("02020080");
    expect(derInteger(Buffer.from([0x80])).toString("hex")).toBe("02020080");
    expect(derInteger(Buffer.from([0x00])).toString("hex")).toBe("020100");
  });

  // Failure: the certificate does not parse, or does not name 127.0.0.1, so the e2e trust test fails before it
  // reaches the app.
  it("is a certificate for 127.0.0.1", () => {
    const { cert } = selfSignedCert();

    expect(new X509Certificate(cert).checkIP("127.0.0.1")).toBe("127.0.0.1");
  });
});
