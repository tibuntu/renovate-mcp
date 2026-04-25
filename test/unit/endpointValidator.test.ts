import { describe, expect, it } from "vitest";
import {
  EndpointValidationError,
  validateEndpoint,
} from "../../src/lib/endpointValidator.js";

function expectReject(endpoint: string, match: RegExp): void {
  expect(() => validateEndpoint(endpoint)).toThrow(EndpointValidationError);
  expect(() => validateEndpoint(endpoint)).toThrow(match);
}

describe("validateEndpoint — accepts public https endpoints", () => {
  it.each([
    "https://api.github.com",
    "https://api.github.com/",
    "https://gitlab.com/api/v4",
    "https://ghe.example.com/api/v3",
    "https://gitlab.example.com/api/v4/",
    "https://gitlab.example.com:8443/api/v4",
  ])("accepts %s", (endpoint) => {
    expect(() => validateEndpoint(endpoint)).not.toThrow();
  });
});

describe("validateEndpoint — rejects non-https schemes", () => {
  it("rejects http://example.com/api/v4", () => {
    expectReject("http://example.com/api/v4", /protocol must be https:/);
  });

  it("rejects file:// scheme", () => {
    expectReject("file:///etc/passwd", /protocol must be https:/);
  });

  it("rejects data: scheme", () => {
    expectReject("data:text/plain,hello", /protocol must be https:/);
  });

  it("rejects ftp:// scheme", () => {
    expectReject("ftp://example.com/", /protocol must be https:/);
  });
});

describe("validateEndpoint — rejects unparseable input", () => {
  it("rejects bare hostnames without scheme", () => {
    expectReject("example.com", /not a parseable URL/);
  });

  it("rejects empty string", () => {
    expectReject("", /not a parseable URL/);
  });
});

describe("validateEndpoint — rejects userinfo", () => {
  it("rejects username-only userinfo", () => {
    expectReject("https://attacker@api.github.com/", /userinfo .* not allowed/);
  });

  it("rejects user:password userinfo", () => {
    expectReject(
      "https://attacker:secret@api.github.com/",
      /userinfo .* not allowed/,
    );
  });
});

describe("validateEndpoint — rejects loopback / link-local / private literals", () => {
  it.each([
    "https://localhost/api/v4",
    "https://localhost:8080/api/v4",
    "https://api.localhost/v4",
    "https://127.0.0.1/api/v4",
    "https://127.1.2.3/",
    "https://10.0.0.1/api/v4",
    "https://10.250.250.250/",
    "https://192.168.1.1/api/v4",
    "https://172.16.0.1/",
    "https://172.20.0.1/",
    "https://172.31.255.255/",
    "https://169.254.169.254/latest/meta-data/iam/security-credentials/", // cloud metadata
    "https://169.254.169.254/",
    "https://0.0.0.0/",
    "https://[::1]/api/v4",
    "https://[::]/",
    "https://[fc00::1]/",
    "https://[fd12:3456:789a::1]/",
    "https://[fe80::1]/",
    "https://[febf::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://[::ffff:169.254.169.254]/",
  ])("rejects %s", (endpoint) => {
    expectReject(endpoint, /private, loopback, or link-local/);
  });
});

describe("validateEndpoint — does not over-reject neighbouring ranges", () => {
  it.each([
    "https://172.15.0.1/", // just outside RFC 1918 172.16-31
    "https://172.32.0.1/",
    "https://11.0.0.1/", // not 10.0.0.0/8
    "https://169.253.0.1/", // not 169.254/16
    "https://[2001:db8::1]/", // documentation range — public
    "https://[fec0::1]/", // not fe80::/10
  ])("accepts %s", (endpoint) => {
    expect(() => validateEndpoint(endpoint)).not.toThrow();
  });
});
