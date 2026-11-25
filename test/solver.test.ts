import { describe, expect, it } from "vitest";
import { archiveFailTwin, archivePass, buildArchiveCase } from "../src/case/fixtures/archive";
import type { Case } from "../src/case/schema";
import { checkCase, solve } from "../src/case/solver";
import { validateCase } from "../src/case/validate";

const clone = (c: Case): Case => structuredClone(c);
const codes = (c: unknown) => {
  const v = validateCase(c);
  return v.ok ? [] : v.issues.map((i) => i.code);
};

describe("the handwritten pair", () => {
  it("accepts the case when the attendance log can be inspected", () => {
    const check = checkCase(archivePass);
    expect(check.reasons).toEqual([]);
    expect(check.accepted).toBe(true);
    expect(check.solve?.proven).toEqual(["s-ada"]);
    expect(check.solve?.survivors).toEqual(["s-ada"]);
  });

  it("returns a proof a player can follow: one inspection", () => {
    const result = solve(archivePass);
    expect(result.proof?.actions).toEqual([{ type: "inspection", id: "i-attendance-log" }]);
    expect(result.proof?.evidence).toEqual(
      expect.arrayContaining(["e-attendance-log", "e-key-register", "e-letters", "e-dinner-photo"]),
    );
  });

  it("catches the culprit's lie with an independent record", () => {
    expect(solve(archivePass).caughtLies).toEqual([
      { suspect: "s-ada", assertion: "a-ada-foyer-2100", statedBy: "t-ada-2100", contradictedBy: "e-attendance-log" },
    ]);
  });

  it("refuses the twin: same hidden truth, but the log cannot be reached", () => {
    // The answer key is identical and still valid.
    expect(validateCase(archiveFailTwin).ok).toBe(true);
    expect(archiveFailTwin.culprit).toEqual(archivePass.culprit);
    expect(archiveFailTwin.evidence).toEqual(archivePass.evidence);

    const check = checkCase(archiveFailTwin);
    expect(check.accepted).toBe(false);
    expect(check.solve?.survivors).toEqual(["s-ada", "s-ben"]);
    expect(check.solve?.proven).toEqual([]);
    expect(check.solve?.proof).toBeNull();
    expect(check.reasons.join("\n")).toMatch(/s-ada, s-ben.*all still fit/);
  });
});

describe("the player proof", () => {
  it("never treats unknown as an exclusion", () => {
    // Take away the dinner photo: six guests are now merely unaccounted for.
    const c = clone(archivePass);
    c.briefing.evidence = c.briefing.evidence.filter((e) => e !== "e-dinner-photo");
    const result = solve(c);
    expect(result.solvable).toBe(false);
    expect(result.survivors).toHaveLength(7);
    expect(result.proven).toEqual(["s-ada"]);
  });

  it("does not count testimony as proof", () => {
    // Ben says he was in the foyer, and it is true, but no record backs it in the twin.
    const result = solve(archiveFailTwin);
    expect(result.survivors).toContain("s-ben");
  });

  it("ignores evidence that is not authoritative", () => {
    const c = clone(archivePass);
    c.evidence.find((e) => e.id === "e-attendance-log")!.authoritative = false;
    const result = solve(c);
    expect(result.solvable).toBe(false);
    expect(result.survivors).toEqual(["s-ada", "s-ben"]);
  });

  it("follows unlock chains and reports them in the proof", () => {
    // The log only becomes visible after Ben has been asked about 21:00.
    const c = clone(archivePass);
    c.actions.inspections[0]!.requires = ["a-ben-foyer-2100"];
    const result = solve(c);
    expect(result.solvable).toBe(true);
    expect(result.proof?.actions).toEqual([
      { type: "topic", id: "t-ben-2100" },
      { type: "inspection", id: "i-attendance-log" },
    ]);
  });

  it("refuses a case whose unlock can never be satisfied", () => {
    const c = clone(archivePass);
    c.actions.inspections[0]!.requires = ["e-attendance-log"]; // needs itself
    expect(solve(c).solvable).toBe(false);
  });

  it("refuses a proof that does not fit in the session", () => {
    const c = clone(archivePass);
    c.actions.inspections[0]!.requires = ["a-ben-foyer-2100"];
    c.sessionCap = 1;
    const result = solve(c);
    expect(result.solvable).toBe(false);
    expect(result.reasons.join("\n")).toMatch(/needs 2 actions/);
  });

  it("refuses when the culprit's lie cannot be caught", () => {
    // Ada's statement is unreachable, so nobody can ever confront her with the record.
    const c = clone(archivePass);
    c.actions.topics.find((t) => t.id === "t-ada-2100")!.requires = ["a-ada-debt"]; // an assertion nobody states
    const result = solve(c);
    expect(result.solvable).toBe(false);
    expect(result.uncaughtLies).toEqual([{ suspect: "s-ada", assertion: "a-ada-foyer-2100" }]);
  });

  it("accepts a record that rules a suspect out by means", () => {
    // Replace Ben's alibi with a record that his key was handed in before the dinner.
    const c = clone(archivePass);
    const ben = c.suspects.find((s) => s.id === "s-ben")!;
    ben.means = [];
    c.assertions.push({ id: "a-ben-no-key", prop: { kind: "means", subject: "s-ben", means: "m-key", value: false } });
    c.evidence.find((e) => e.id === "e-key-register")!.proves = ["a-ada-key", "a-ben-no-key"];
    c.evidence.find((e) => e.id === "e-attendance-log")!.proves = ["a-ada-archive-2100"];
    expect(validateCase(c).ok).toBe(true);
    const result = solve(c);
    expect(result.solvable).toBe(true);
    expect(result.survivors).toEqual(["s-ada"]);
  });

  it("gives the same verdict whatever order the file lists things in", () => {
    const c = clone(archivePass);
    c.suspects.reverse();
    c.assertions.reverse();
    c.evidence.reverse();
    c.actions.topics.reverse();
    expect(checkCase(c).accepted).toBe(true);
    const twin = buildArchiveCase({ attendanceLogReachable: false });
    twin.suspects.reverse();
    expect(checkCase(twin).accepted).toBe(false);
  });
});

describe("the validator", () => {
  it("accepts both handwritten cases as coherent truth", () => {
    expect(codes(archivePass)).toEqual([]);
    expect(codes(archiveFailTwin)).toEqual([]);
  });

  it("rejects unknown fields and missing fields", () => {
    expect(codes({ ...archivePass, extra: true })).toEqual(["schema"]);
    const { culprit: _culprit, ...rest } = archivePass;
    expect(codes(rest)).toEqual(["schema"]);
  });

  it("rejects an id that does not resolve", () => {
    const c = clone(archivePass);
    c.culprit.suspect = "s-nobody";
    expect(codes(c)).toContain("unknown-id");
  });

  it("rejects an id used twice", () => {
    const c = clone(archivePass);
    c.evidence[0]!.id = "s-ada";
    expect(codes(c)).toContain("duplicate-id");
  });

  it("rejects a move between rooms that are not connected", () => {
    const c = clone(archivePass);
    c.suspects.find((s) => s.id === "s-clara")!.whereabouts["21:20"] = "l-archive"; // dining -> archive
    expect(codes(c)).toContain("impossible-move");
  });

  it("rejects a truth with two possible culprits", () => {
    const c = clone(archivePass);
    c.suspects.find((s) => s.id === "s-ben")!.whereabouts["21:00"] = "l-archive";
    expect(codes(c)).toContain("truth-not-unique");
  });

  it("rejects a truth with no possible culprit", () => {
    const c = clone(archivePass);
    c.suspects.find((s) => s.id === "s-ada")!.means = [];
    expect(codes(c)).toContain("truth-not-unique");
  });

  it("rejects a culprit field that disagrees with the truth", () => {
    const c = clone(archivePass);
    c.culprit = { suspect: "s-ben", motive: "mo-will" };
    expect(codes(c)).toContain("culprit-mismatch");
  });

  it("rejects an authoritative record that is false", () => {
    const c = clone(archivePass);
    c.evidence.find((e) => e.id === "e-attendance-log")!.proves = ["a-ada-foyer-2100"];
    expect(codes(c)).toContain("false-record");
  });

  it("rejects a false statement that is not declared as a lie", () => {
    const c = clone(archivePass);
    c.suspects.find((s) => s.id === "s-ada")!.lies = [];
    expect(codes(c)).toContain("undeclared-lie");
  });

  it("rejects a declared lie that is true, or that nobody says", () => {
    const c = clone(archivePass);
    c.suspects.find((s) => s.id === "s-ben")!.lies = ["a-ben-foyer-2100"];
    expect(codes(c)).toContain("lie-is-true");
    const d = clone(archivePass);
    d.suspects.find((s) => s.id === "s-clara")!.lies = ["a-ada-foyer-2100"];
    expect(codes(d)).toContain("lie-never-stated");
  });
});
