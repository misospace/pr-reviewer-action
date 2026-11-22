/** #1773: the in-cluster TLS identity of the API transport.
 * `KUBERNETES_SERVICE_HOST` is the kubelet-projected service address — in
 * the universal default an IP literal (the ClusterIP) — and no apiserver
 * certificate carries its service ClusterIP in the SAN set, so an IP SNI
 * fails every handshake. The derived `servername` is the fix surface:
 * IP literals present the conventional in-cluster DNS name, hostnames stay
 * verbatim, the socket still connects to `host`, and TLS verification is
 * never skipped. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apiTlsServername,
  buildMaterial,
  IN_CLUSTER_API_SERVICE_NAME,
} from "../src/executor/kubernetes-api.js";

function fakeServiceAccountDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "k8s-api-sa-"));
  writeFileSync(join(dir, "token"), "sa-token-xyzzy\n");
  writeFileSync(join(dir, "ca.crt"), "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n");
  return dir;
}

test("the in-cluster SNI constant is the conventional API service name", () => {
  assert.equal(IN_CLUSTER_API_SERVICE_NAME, "kubernetes.default.svc");
});

test("an IP-literal API host derives the conventional SNI name, not the IP (#1773)", () => {
  assert.equal(apiTlsServername("10.43.0.1"), "kubernetes.default.svc");
  assert.equal(apiTlsServername("172.30.0.1"), "kubernetes.default.svc");
  assert.equal(apiTlsServername("fd00::1"), "kubernetes.default.svc");
});

test("a hostname API host keeps servername === host (unchanged)", () => {
  assert.equal(apiTlsServername("kubernetes"), "kubernetes");
  assert.equal(apiTlsServername("apiserver.internal.example"), "apiserver.internal.example");
});

test("buildMaterial derives the servername while keeping the connect host", () => {
  const dir = fakeServiceAccountDir();
  try {
    const viaClusterIp = buildMaterial({ serviceAccountDir: dir, host: "10.43.0.1", port: "443" });
    assert.equal(viaClusterIp.host, "10.43.0.1", "the socket still connects to the projected host");
    assert.equal(viaClusterIp.servername, "kubernetes.default.svc");
    const viaHostname = buildMaterial({ serviceAccountDir: dir, host: "kubernetes.default", port: "6443" });
    assert.equal(viaHostname.servername, viaHostname.host, "a hostname keeps SNI === host");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the transport never opts out of certificate verification (#1773)", () => {
  const codeLines = readFileSync("src/executor/kubernetes-api.ts", "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  assert.doesNotMatch(
    codeLines.join("\n"),
    /rejectUnauthorized/,
    "the fix must come from the SNI name; verification is never reconfigured, let alone skipped",
  );
  assert.match(
    codeLines.join("\n"),
    /tlsOptions\.servername = material\.servername;/,
    "the https branch must present the derived servername, never the raw host",
  );
});
