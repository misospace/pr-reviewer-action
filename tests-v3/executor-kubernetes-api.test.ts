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
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apiRequest,
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

test("a bracketed IPv6 literal is the same IP, not an invalid SNI hostname (#1773)", () => {
  assert.equal(apiTlsServername("[fd00::1]"), "kubernetes.default.svc");
  assert.equal(apiTlsServername("[::1]"), "kubernetes.default.svc");
  assert.equal(apiTlsServername("[kubernetes.internal]"), "[kubernetes.internal]");
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

test("the live https request options carry the derived servername, not the ClusterIP (#1773)", async () => {
  const original = https.request;
  let captured: https.RequestOptions | undefined;
  (https as { request: unknown }).request = (options: https.RequestOptions) => {
    captured = options;
    const fake = new http.ClientRequest("http://127.0.0.1:1", () => undefined);
    fake.on("error", () => undefined);
    process.nextTick(() => fake.destroy(new Error("stubbed")));
    return fake;
  };
  const dir = fakeServiceAccountDir();
  let material: ReturnType<typeof buildMaterial> | undefined;
  try {
    material = buildMaterial({ serviceAccountDir: dir, host: "10.43.0.1", port: "443" });
    await assert.rejects(apiRequest(material, "GET", "/apis/batch/v1/namespaces/default/jobs", null));
  } finally {
    (https as { request: unknown }).request = original;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(captured, "the transport must go through https.request");
  assert.ok(material);
  assert.equal(captured.servername, "kubernetes.default.svc", "the live TLS identity is the derived name, never the IP");
  assert.equal(captured.host, "10.43.0.1", "the socket still connects to the projected host");
  assert.equal((captured.ca as Buffer).equals(material.ca as Buffer), true, "verification anchors on the projected CA");
});
