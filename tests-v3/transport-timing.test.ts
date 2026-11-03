import test from "node:test";
import assert from "node:assert/strict";
import { runHttpRequest } from "../src/transport/http.js";
import { runChatRequest } from "../src/transport/transport.js";
import { readTransportTiming, TRANSPORT_TIMING, type TransportTiming } from "../src/transport/timing.js";
import { startMockServer, type MockServer } from "./helpers.js";
import type { TransportWirePayload } from "../src/model/types.js";

/**
 * #1466: the transport's timing probe.
 *
 * The probe answers one question — WHEN did the provider answer — so the
 * Action can tell a slow provider from a fast one. It is observation
 * only: the response body is reassembled exactly as before, and the
 * timing rides the response under a non-enumerable symbol so it can never
 * reach an artifact or a log line.
 */

function payload(body: Record<string, unknown>): TransportWirePayload {
  return { endpointPath: "/chat/completions", body: body as unknown as TransportWirePayload["body"] };
}

/** One SSE frame and how long the server waits before writing it. */
interface TimedFrame {
  /** The frame text: a `data:` line plus the blank line that ends it. */
  frame: string;
  /** Milliseconds to wait before this frame is written. */
  delayMs: number;
}

/** A local `node:http` server that writes SSE frames with deliberate
 * delays, so the probe's "first byte" and "first content" instants are
 * separated by a measurable gap. */
function sseServer(frames: TimedFrame[]): Promise<MockServer> {
  return startMockServer((_req, _body, res) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    let index = 0;
    const writeNext = (): void => {
      if (index >= frames.length) {
        res.end();
        return;
      }
      const entry = frames[index++]!;
      setTimeout(() => {
        res.write(entry.frame);
        writeNext();
      }, entry.delayMs);
    };
    writeNext();
  });
}

const ANTHROPIC_STREAM: TimedFrame[] = [
  {
    // The envelope event: bytes arrive, but no content does.
    frame: 'data: {"type":"message_start","message":{"id":"m1","model":"m","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
    delayMs: 0,
  },
  {
    // The first CONTENT-bearing event, 150ms later.
    frame: 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
    delayMs: 150,
  },
  {
    frame: 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
    delayMs: 20,
  },
];

test("#1466: a streamed call reports when the first byte and the first content event arrived", async () => {
  const server = await sseServer(ANTHROPIC_STREAM);
  try {
    const outcome = await runChatRequest({
      baseUrl: server.url,
      apiFormat: "anthropic",
      payload: { endpointPath: "/messages", body: { model: "m", stream: true, max_tokens: 64 } as unknown as TransportWirePayload["body"] },
      apiKey: "",
      anthropicVersion: "2023-06-01",
      requestTimeoutSec: 10,
      connectTimeoutSec: 5,
    });
    assert.equal(outcome.status, "ok");
    if (outcome.status !== "ok") return;
    const timing = outcome.timing;
    assert.ok(timing !== undefined, "the outcome carries the timing of its wire call");
    assert.ok(timing.firstEventSec !== null, "the first body byte was measured");
    assert.ok(timing.firstContentSec !== null, "the first content event was measured");
    assert.ok(timing.firstEventSec <= timing.firstContentSec, "the first byte precedes the first content");
    assert.ok(timing.firstContentSec <= timing.totalSec, "the first content precedes the response end");
    // The content frame was written ~150ms after the envelope frame.
    assert.ok(timing.firstContentSec >= 0.1, `the first content event must be delayed, got ${timing.firstContentSec}`);
    assert.ok(timing.firstEventSec < timing.firstContentSec, "the envelope frame arrived before the content frame");
    assert.ok(timing.totalSec >= 0.15, "the response end is after the delayed content frame");
  } finally {
    await server.close();
  }
});

test("#1466: the timing is readable from the returned response and stays out of its serialization", async () => {
  const server = await sseServer(ANTHROPIC_STREAM);
  try {
    const outcome = await runChatRequest({
      baseUrl: server.url,
      apiFormat: "anthropic",
      payload: { endpointPath: "/messages", body: { model: "m", stream: true, max_tokens: 64 } as unknown as TransportWirePayload["body"] },
      apiKey: "",
      anthropicVersion: "2023-06-01",
      requestTimeoutSec: 10,
      connectTimeoutSec: 5,
    });
    assert.equal(outcome.status, "ok");
    if (outcome.status !== "ok") return;
    const timing = readTransportTiming(outcome.response);
    assert.ok(timing !== null, "the response carries the timing");
    assert.deepEqual(timing, outcome.timing, "the timing read back is the timing reported");
    // The probe is NOT enumerable: neither a JSON artifact write nor a
    // property enumeration may ever see it.
    const serialized = JSON.stringify(outcome.response);
    assert.equal(serialized.includes("firstEventSec"), false);
    assert.equal(serialized.includes("firstContentSec"), false);
    assert.equal(serialized.includes("totalSec"), false);
    assert.equal(Object.keys(outcome.response).includes("firstEventSec"), false);
    // The symbol property IS an own property of the response.
    const symbols = Object.getOwnPropertySymbols(outcome.response);
    assert.equal(symbols.includes(TRANSPORT_TIMING), true);
    const descriptor = Object.getOwnPropertyDescriptor(outcome.response, TRANSPORT_TIMING);
    assert.equal(descriptor?.enumerable, false, "the timing property is non-enumerable");
  } finally {
    await server.close();
  }
});

test("#1466: a non-streamed call reports a first byte but no content event", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.statusCode = 200;
    res.end(JSON.stringify({ id: "1", choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
  });
  try {
    const outcome = await runChatRequest({
      baseUrl: server.url,
      apiFormat: "openai",
      payload: payload({ model: "m", stream: false, messages: [] }),
      apiKey: "",
      anthropicVersion: "2023-06-01",
      requestTimeoutSec: 10,
      connectTimeoutSec: 5,
    });
    assert.equal(outcome.status, "ok");
    if (outcome.status !== "ok") return;
    const timing = outcome.timing;
    assert.ok(timing !== undefined);
    assert.ok(timing.firstEventSec !== null, "the body byte was measured");
    assert.equal(timing.firstContentSec, null, "a non-streamed body carries no content event on the wire");
    assert.ok(timing.totalSec >= 0);
    // The parsed provider body carries the probe too.
    const rawTiming = readTransportTiming(outcome.raw);
    assert.deepEqual(rawTiming, timing);
    assert.equal(JSON.stringify(outcome.raw).includes("firstEventSec"), false);
  } finally {
    await server.close();
  }
});

test("#1466: the HTTP call itself reports its timing", async () => {
  const server = await sseServer(ANTHROPIC_STREAM);
  try {
    const result = await runHttpRequest({
      baseUrl: server.url,
      apiFormat: "anthropic",
      bodyText: JSON.stringify({ model: "m", stream: true, max_tokens: 64 }),
      apiKey: "",
      anthropicVersion: "2023-06-01",
      requestTimeoutSec: 10,
      connectTimeoutSec: 5,
      stream: true,
    });
    assert.equal(result.status, 200);
    const timing: TransportTiming = result.timing;
    assert.ok(timing.firstEventSec !== null);
    assert.ok(timing.firstContentSec !== null);
    assert.ok(timing.firstEventSec < timing.firstContentSec);
    assert.ok(timing.firstContentSec <= timing.totalSec);
    // The body is still the provider's bytes — the scan changed nothing.
    assert.ok(result.body.includes("content_block_delta"));
  } finally {
    await server.close();
  }
});

test("#1466: every wire call of one request is reported with its attempt index and its own timing", async () => {
  let requests = 0;
  const server = await startMockServer((_req, _body, res) => {
    requests++;
    if (requests === 1) {
      res.statusCode = 429;
      res.setHeader("Retry-After", "0");
      res.end(JSON.stringify({ error: { message: "slow down" } }));
      return;
    }
    res.statusCode = 200;
    res.end(JSON.stringify({ id: "1", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
  });
  const seen: { discarded: boolean; attempt?: number | undefined; timing?: TransportTiming | undefined }[] = [];
  try {
    const outcome = await runChatRequest({
      baseUrl: server.url,
      apiFormat: "openai",
      payload: payload({ model: "m", stream: false, messages: [] }),
      apiKey: "",
      anthropicVersion: "2023-06-01",
      requestTimeoutSec: 10,
      connectTimeoutSec: 5,
      sleep: async () => {},
      onWireCall: (report) => { seen.push({ discarded: report.discarded, attempt: report.attempt, timing: report.timing }); },
    });
    assert.equal(outcome.status, "ok");
    assert.equal(requests, 2);
    assert.deepEqual(seen.map((call) => call.discarded), [true, false]);
    assert.deepEqual(seen.map((call) => call.attempt), [1, 2], "the wire calls of one request are numbered in order");
    // The discarded 429 call produced no response body, so it has no
    // timing to report; the answered call carries its own.
    assert.equal(seen[0]!.timing, undefined);
    assert.ok(seen[1]!.timing !== undefined, "the answered call reports its timing");
    assert.ok(seen[1]!.timing!.firstEventSec !== null);
  } finally {
    await server.close();
  }
});

test("#1466: a clamp retry continues the attempt numbering of the same request", async () => {
  let requests = 0;
  const server = await startMockServer((_req, _body, res) => {
    requests++;
    if (requests === 1) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message: "max_tokens: 16384 > 8192, which is the maximum allowed number of output tokens for <model>" } }));
      return;
    }
    res.statusCode = 200;
    res.end(JSON.stringify({ id: "1", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
  });
  const seen: { discarded: boolean; attempt?: number | undefined }[] = [];
  try {
    const outcome = await runChatRequest({
      baseUrl: server.url,
      apiFormat: "openai",
      payload: payload({ model: "m", stream: false, max_tokens: 16384, messages: [] }),
      apiKey: "",
      anthropicVersion: "2023-06-01",
      requestTimeoutSec: 10,
      connectTimeoutSec: 5,
      onWireCall: (report) => { seen.push({ discarded: report.discarded, attempt: report.attempt }); },
    });
    assert.equal(outcome.status, "ok");
    assert.equal(requests, 2);
    assert.deepEqual(seen.map((call) => call.discarded), [true, false]);
    assert.deepEqual(seen.map((call) => call.attempt), [1, 2], "the follow-up call continues the numbering");
  } finally {
    await server.close();
  }
});

test("#1466: readTransportTiming returns null for a value that carries no timing", () => {
  assert.equal(readTransportTiming(null), null);
  assert.equal(readTransportTiming(undefined), null);
  assert.equal(readTransportTiming("text"), null);
  assert.equal(readTransportTiming({}), null);
  assert.equal(readTransportTiming({ firstEventSec: 1, firstContentSec: 2, totalSec: 3 }), null);
});

test("#1466: a stream that ends its event lines with a single LF still reports its first content event", async () => {
  // No blank line anywhere: the frame boundary never arrives, so the
  // scanner must still see the content event in the `data:` line itself.
  const server = await startMockServer((_req, _body, res) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.write('data: {"type":"message_start","message":{"id":"m1"}}\n');
    setTimeout(() => {
      res.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n');
      res.end();
    }, 120);
  });
  try {
    const outcome = await runChatRequest({
      baseUrl: server.url,
      apiFormat: "anthropic",
      payload: { endpointPath: "/messages", body: { model: "m", stream: true, max_tokens: 64 } as unknown as TransportWirePayload["body"] },
      apiKey: "",
      anthropicVersion: "2023-06-01",
      requestTimeoutSec: 10,
      connectTimeoutSec: 5,
    });
    assert.equal(outcome.status, "ok");
    if (outcome.status !== "ok") return;
    const timing = outcome.timing;
    assert.ok(timing !== undefined);
    assert.ok(timing.firstContentSec !== null, "the content event was seen");
    assert.ok(timing.firstContentSec >= 0.1, `the content event was delayed, got ${timing.firstContentSec}`);
  } finally {
    await server.close();
  }
});

test("#1466: a content event only the end-of-response flush finds never lands after the response end", async () => {
  // The last frame's `data:` line arrives with NO line terminator at all, so
  // the scanner never reads it as a line — only the end-of-response flush
  // finds it. That flush runs at the very end of the response, so the
  // content instant it stamps must still not be later than the response end.
  const server = await startMockServer((_req, _body, res) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.write('data: {"type":"message_start","message":{"id":"m1"}}\n\n');
    setTimeout(() => {
      res.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}');
      res.end();
    }, 120);
  });
  try {
    const outcome = await runChatRequest({
      baseUrl: server.url,
      apiFormat: "anthropic",
      payload: { endpointPath: "/messages", body: { model: "m", stream: true, max_tokens: 64 } as unknown as TransportWirePayload["body"] },
      apiKey: "",
      anthropicVersion: "2023-06-01",
      requestTimeoutSec: 10,
      connectTimeoutSec: 5,
    });
    assert.equal(outcome.status, "ok");
    if (outcome.status !== "ok") return;
    const timing = outcome.timing;
    assert.ok(timing !== undefined);
    assert.ok(timing.firstContentSec !== null, "the flushed content event was found");
    assert.ok(timing.firstContentSec >= 0.1, `the content event was delayed, got ${timing.firstContentSec}`);
    assert.ok(timing.firstEventSec !== null && timing.firstEventSec <= timing.firstContentSec, "the first byte precedes the first content");
    assert.ok(timing.firstContentSec <= timing.totalSec, "the first content precedes the response end");
  } finally {
    await server.close();
  }
});

test("#1466: a frame whose joined payload exceeds the byte ceiling is dropped, and the scan carries on", async () => {
  // The frame's `data:` lines are joined into ONE payload, and that payload
  // is bigger than the frame byte ceiling: the join is dropped (a partial
  // join could parse as a payload the provider never sent), so the content
  // event it carried is never reported. The NEXT frame is still inspected.
  const padding = "A".repeat(70 * 1024);
  const server = await startMockServer((_req, _body, res) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    // One oversized frame: neither of its lines is valid JSON on its own, so
    // only the JOINED payload could have carried the content event.
    res.write(`data: {"type":"content_block_delta","pad":"${padding}"\n`);
    res.write('data: ,"delta":{"type":"text_delta","text":"oversized"}}\n\n');
    setTimeout(() => {
      res.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n');
      res.end();
    }, 120);
  });
  try {
    const outcome = await runChatRequest({
      baseUrl: server.url,
      apiFormat: "anthropic",
      payload: { endpointPath: "/messages", body: { model: "m", stream: true, max_tokens: 64 } as unknown as TransportWirePayload["body"] },
      apiKey: "",
      anthropicVersion: "2023-06-01",
      requestTimeoutSec: 10,
      connectTimeoutSec: 5,
    });
    assert.equal(outcome.status, "ok");
    if (outcome.status !== "ok") return;
    const timing = outcome.timing;
    assert.ok(timing !== undefined);
    assert.ok(timing.firstContentSec !== null, "the next frame's content event was still found");
    // The oversized frame's content event was NOT the one reported: the
    // reported one comes from the frame that arrived 120ms later.
    assert.ok(timing.firstContentSec >= 0.1, `the reported content event is the delayed one, got ${timing.firstContentSec}`);
    assert.ok(timing.firstContentSec <= timing.totalSec, "the first content precedes the response end");
  } finally {
    await server.close();
  }
});

test("#1466: a frame whose data field spans several lines is inspected as the joined payload", async () => {
  // SSE joins the `data:` lines of one frame into ONE payload, so the
  // joined form is what carries the event.
  const server = await startMockServer((_req, _body, res) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.write('data: {"type":"message_start","message":{"id":"m1"}}\n\n');
    setTimeout(() => {
      res.write('data: {"type":"content_block_delta",\n');
      res.write('data:  "delta":{"type":"text_delta","text":"hi"}}\n\n');
      res.end();
    }, 120);
  });
  try {
    const outcome = await runChatRequest({
      baseUrl: server.url,
      apiFormat: "anthropic",
      payload: { endpointPath: "/messages", body: { model: "m", stream: true, max_tokens: 64 } as unknown as TransportWirePayload["body"] },
      apiKey: "",
      anthropicVersion: "2023-06-01",
      requestTimeoutSec: 10,
      connectTimeoutSec: 5,
    });
    assert.equal(outcome.status, "ok");
    if (outcome.status !== "ok") return;
    const timing = outcome.timing;
    assert.ok(timing !== undefined);
    assert.ok(timing.firstContentSec !== null, "the joined frame payload was inspected");
    assert.ok(timing.firstContentSec >= 0.1, `the content event was delayed, got ${timing.firstContentSec}`);
  } finally {
    await server.close();
  }
});
