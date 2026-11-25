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

describe("alternatives are never multiplied out or cut off", () => {
  // Four motives, three separate denial records for each (81 combinations), and only the
  // third copy of each is in the briefing. Found by Codex's review of the session search.
  function fourMotives(reverseEvidence: boolean): Case {
    const c = clone(archivePass);
    c.sessionCap = 2;
    c.motives.push(
      { id: "mo-rival", text: { en: "A professional rivalry.", zh: "职业上的竞争。" } },
      { id: "mo-secret", text: { en: "A secret the victim knew.", zh: "死者知道的一个秘密。" } },
    );
    c.suspects.find((s) => s.id === "s-ben")!.motives = [];
    c.evidence.find((e) => e.id === "e-letters")!.proves = ["a-ada-debt"];
    c.evidence.find((e) => e.id === "e-attendance-log")!.proves = ["a-ada-archive-2100"];
    for (const m of c.motives) {
      for (const copy of [1, 2, 3]) {
        const assertion = `a-ben-no-${m.id}-${copy}`;
        const evidence = `e-ben-no-${m.id}-${copy}`;
        c.assertions.push({ id: assertion, prop: { kind: "motive", subject: "s-ben", motive: m.id, value: false } });
        c.evidence.push({ id: evidence, kind: "record", authoritative: true, proves: [assertion], text: { en: "A sworn statement.", zh: "一份宣誓声明。" } });
        if (copy === 3) c.briefing.evidence.push(evidence);
      }
    }
    if (reverseEvidence) c.evidence.reverse();
    return c;
  }

  it.each([false, true])("gives the same verdict when the evidence list is reversed (%s)", (reversed) => {
    const check = checkCase(fourMotives(reversed));
    expect(check.reasons).toEqual([]);
    expect(check.accepted).toBe(true);
    expect(check.solve?.survivors).toEqual(["s-ada"]);
    expect(check.solve?.proof?.actions).toEqual([{ type: "inspection", id: "i-attendance-log" }]);
    // The proof cites the denial records the player actually holds: the third copies.
    expect(check.solve?.proof?.evidence).toEqual(expect.arrayContaining(c3(fourMotives(reversed))));
  });
  const c3 = (c: Case) => c.motives.map((m) => `e-ben-no-${m.id}-3`);

  it("still refuses when one motive has no denial in reach", () => {
    const c = fourMotives(false);
    c.briefing.evidence = c.briefing.evidence.filter((e) => e !== "e-ben-no-mo-secret-3");
    const check = checkCase(c);
    expect(check.accepted).toBe(false);
    expect(check.solve?.survivors).toEqual(["s-ada", "s-ben"]);
  });
});

describe("twenty suspects", () => {
  // The archive case grown to 20 suspects: 18 diners, each cleared by a record of their own.
  function twenty(sessionCap: number): Case {
    const c = clone(archivePass);
    c.sessionCap = sessionCap;
    const template = c.suspects.find((s) => s.id === "s-clara")!;
    c.suspects = c.suspects.filter((s) => s.id === "s-ada" || s.id === "s-ben");
    c.assertions = c.assertions.filter((a) => a.prop.subject === "s-ada" || a.prop.subject === "s-ben");
    c.evidence = c.evidence.filter((e) => e.id !== "e-dinner-photo");
    c.briefing.evidence = c.briefing.evidence.filter((e) => e !== "e-dinner-photo");
    for (let i = 1; i <= 18; i++) {
      const id = `s-diner-${i}`;
      c.suspects.push({ ...clone({ ...archivePass, suspects: [template] }).suspects[0]!, id, name: { en: `Diner ${i}`, zh: `客人${i}` } });
      c.assertions.push({ id: `a-diner-${i}`, prop: { kind: "at", subject: id, slot: "21:00", location: "l-dining" } });
      c.evidence.push({ id: `e-seat-${i}`, kind: "record", authoritative: true, proves: [`a-diner-${i}`], text: { en: `Seat card ${i}.`, zh: `座位卡${i}。` } });
      c.actions.inspections.push({ id: `i-seat-${i}`, label: { en: `Check seat ${i}`, zh: `查看${i}号座位` }, yields: [`e-seat-${i}`] });
    }
    return c;
  }

  it("accepts a case that needs nineteen inspections, quickly", () => {
    const started = performance.now();
    const check = checkCase(twenty(40));
    expect(check.reasons).toEqual([]);
    expect(check.solve?.proof?.actions).toHaveLength(19);
    expect(check.solve?.exhaustive).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("refuses when the session is too short, and says its survivor list is only a sample", () => {
    const check = checkCase(twenty(10));
    expect(check.accepted).toBe(false);
    // The verdict is exact: no unlimited-length search was needed to refuse it.
    expect(check.solve?.exhaustive).toBe(true);
    expect(check.solve?.survivorSetsComplete).toBe(false);
    expect(check.solve?.survivorSets.length).toBeLessThanOrEqual(50);
    // Every listed set is one a real ten-action session leaves: Ada plus ten uncleared people.
    for (const set of check.solve!.survivorSets) expect(set).toHaveLength(10);
    expect(check.reasons.join("\n")).toMatch(/needs (19|more than 10) actions/);
  });
});
