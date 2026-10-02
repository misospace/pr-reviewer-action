import test from "node:test";
import assert from "node:assert/strict";
import { decideAdoption, type AdoptionPolicy, type AdoptionRepository } from "../src/config/adoption.js";

function policy(overrides: Partial<AdoptionPolicy> = {}): AdoptionPolicy {
  return {
    mode: "all_allowed",
    allowlist: [],
    denylist: [],
    discoveredDefault: "adopt",
    ...overrides,
  };
}

function repository(overrides: Partial<AdoptionRepository> = {}): AdoptionRepository {
  return {
    identity: "owner/repo",
    operatorOptedIn: false,
    operatorOptedOut: false,
    repositoryConfigEnabled: null,
    ...overrides,
  };
}

test("#727: adoption decisions are deterministic — same inputs, same decision", () => {
  const inputs = [
    { p: policy(), r: repository() },
    { p: policy({ mode: "allowlist", allowlist: ["owner/repo"] }), r: repository() },
    { p: policy({ mode: "opt_in" }), r: repository({ operatorOptedIn: true }) },
    { p: policy({ mode: "opt_out" }), r: repository({ operatorOptedOut: true, repositoryConfigEnabled: false }) },
    { p: policy({ denylist: ["owner/repo"] }), r: repository({ repositoryConfigEnabled: true }) },
  ];
  for (const { p, r } of inputs) {
    const first = decideAdoption(p, r);
    assert.deepEqual(decideAdoption(p, r), first);
    assert.deepEqual(decideAdoption({ ...p, allowlist: [...p.allowlist], denylist: [...p.denylist] }, { ...r }), first);
  }
});

test("all_allowed adopts every discovered repository unless denied or the repository disables itself", () => {
  assert.deepEqual(decideAdoption(policy(), repository()), {
    state: "enabled",
    reason: "installation-wide adoption (all allowed repositories)",
  });
  assert.equal(decideAdoption(policy(), repository({ repositoryConfigEnabled: false })).state, "disabled");
  assert.equal(decideAdoption(policy(), repository({ repositoryConfigEnabled: true })).state, "enabled");
  // Absent repository config behaves like enabled: adoption needs no per-repo workflow or file.
  assert.equal(decideAdoption(policy(), repository({ repositoryConfigEnabled: null })).state, "enabled");
});

test("allowlist mode: on the list is eligible, off the list stays discovered", () => {
  const p = policy({ mode: "allowlist", allowlist: ["owner/repo"] });
  assert.equal(decideAdoption(p, repository()).state, "enabled");
  assert.equal(decideAdoption(p, repository({ identity: "other/repo" })).state, "discovered");
  assert.match(decideAdoption(p, repository({ identity: "other/repo" })).reason, /not on the operator allowlist/);
});

test("opt_in mode: only the operator's explicit opt-in record is eligible", () => {
  const p = policy({ mode: "opt_in" });
  assert.equal(decideAdoption(p, repository({ operatorOptedIn: true })).state, "enabled");
  const pending = decideAdoption(p, repository());
  assert.equal(pending.state, "discovered");
  assert.match(pending.reason, /awaiting explicit operator opt-in/);
});

test("opt_out mode: everyone is eligible unless the operator recorded an opt-out", () => {
  const p = policy({ mode: "opt_out" });
  assert.equal(decideAdoption(p, repository()).state, "enabled");
  assert.equal(decideAdoption(p, repository({ operatorOptedOut: true })).state, "discovered");
});

test("the denylist is the hard off switch in every mode, over allowlist and repository config alike", () => {
  const cases: readonly AdoptionPolicy[] = [
    policy({ denylist: ["owner/repo"] }),
    policy({ mode: "allowlist", allowlist: ["owner/repo"], denylist: ["owner/repo"] }),
    policy({ mode: "opt_in", denylist: ["owner/repo"] }),
    policy({ mode: "opt_out", denylist: ["owner/repo"] }),
  ];
  for (const p of cases) {
    const decision = decideAdoption(p, repository({ repositoryConfigEnabled: true, operatorOptedIn: true }));
    assert.equal(decision.state, "disabled", p.mode);
    assert.match(decision.reason, /denylist/, p.mode);
  }
});

test("discoveredDefault: skip holds eligible repositories at eligible — repository config cannot force-adopt", () => {
  const p = policy({ discoveredDefault: "skip" });
  const held = decideAdoption(p, repository());
  assert.equal(held.state, "eligible");
  assert.match(held.reason, /operator default for newly discovered repositories is skip/);
  // Narrow-only: `enabled: true` in repository config never grants an
  // adoption the operator default withheld; `enabled: false` is moot here.
  assert.equal(decideAdoption(p, repository({ repositoryConfigEnabled: true })).state, "eligible");
  assert.equal(decideAdoption(p, repository({ repositoryConfigEnabled: false })).state, "eligible");
});

test("adopted repositories can always disable review via repository config, never the reverse", () => {
  const decision = decideAdoption(policy(), repository({ repositoryConfigEnabled: false }));
  assert.equal(decision.state, "disabled");
  assert.match(decision.reason, /repository config disabled review/);
});

test("the allowlist only applies in allowlist mode; the denylist applies in all of them", () => {
  // An allowlist entry does not bypass an opt_in gate...
  assert.equal(decideAdoption(policy({ mode: "opt_in", allowlist: ["owner/repo"] }), repository()).state, "discovered");
  // ...and an opt-in record does not bypass an allowlist gate.
  assert.equal(decideAdoption(policy({ mode: "allowlist" }), repository({ operatorOptedIn: true })).state, "discovered");
});
