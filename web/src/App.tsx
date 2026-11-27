import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, GameError, type CasesReply, type View, type ViewReply } from "./api";
import { dollars, pick, S, victimLine, type Lang, type Text } from "./strings";

type Shown = NonNullable<NonNullable<ViewReply["ask"]>["shown"]>;

/** What the browser remembers between visits: the language, and which session was open. Neither is a secret. */
const remembered = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null): void {
    try {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    } catch {
      // Nothing to do: the page works without it.
    }
  },
};
const firstLanguage = (): Lang => {
  const saved = remembered.get("ta.lang");
  if (saved === "en" || saved === "zh") return saved;
  return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
};

export function App() {
  const [lang, setLang] = useState<Lang>(firstLanguage);
  const [cases, setCases] = useState<CasesReply | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Text | null>(null);
  const [notice, setNotice] = useState<Text | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const t = useCallback((text: Text) => pick(lang, text), [lang]);

  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-Hans" : "en";
    remembered.set("ta.lang", lang);
  }, [lang]);

  const leave = useCallback(() => {
    remembered.set("ta.session", null);
    setView(null);
    setShown(null);
    setNotice(null);
  }, []);

  // On arrival: the library, and the session that was open, if it is still there.
  useEffect(() => {
    let gone = false;
    api
      .cases()
      .then((reply) => !gone && setCases(reply))
      .catch((e: unknown) => !gone && setError(e instanceof GameError ? e.text : S.networkError));
    const session = remembered.get("ta.session");
    if (session) {
      api
        .view(session)
        .then((reply) => !gone && setView(reply.view))
        .catch((e: unknown) => {
          // Forget the session only when the server says it is gone. If the server could not
          // be reached, the game may well still be there: keep its locator and say what happened.
          if (e instanceof GameError && (e.code === "not-found" || e.code === "expired")) remembered.set("ta.session", null);
          else if (!gone) setError(e instanceof GameError ? e.text : S.networkError);
        });
    }
    return () => {
      gone = true;
    };
  }, []);

  /** Do one thing on the server and show where the game stands afterwards. */
  const run = useCallback(
    async (work: () => Promise<ViewReply>, current: View | null) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      setNotice(null);
      setShown(null);
      try {
        const reply = await work();
        setView(reply.view);
        remembered.set("ta.session", reply.view.session);
        if (reply.ask?.notice) setNotice(reply.ask.notice.text);
        if (reply.ask?.replayed && reply.ask.shown) setShown(reply.ask.shown);
      } catch (e) {
        const failure = e instanceof GameError ? e : new GameError("network", S.networkError);
        setError(failure.text);
        if (failure.code === "not-found" || failure.code === "expired") leave();
        // The game may have moved on without this page: read it again rather than guess.
        else if (current && ["stale", "busy", "server", "network"].includes(failure.code)) {
          try {
            setView((await api.view(current.session)).view);
          } catch {
            // The error already on screen says what to do.
          }
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, leave],
  );

  return (
    <div className="app">
      <header className="top">
        <button className="brand" onClick={leave} title={t(S.backToCases)}>
          <span className="brand-name">
            {S.brand.en} · {S.brand.zh}
          </span>
          <span className="brand-tag">{t(S.tagline)}</span>
        </button>
        <div className="top-right">
          {view && (
            <div className="meters" aria-live="polite">
              <span className="meter">
                {t(S.actionsLeft)} <strong>{view.actions.left}</strong> / {view.actions.cap}
              </span>
              <span className="meter" title={t(view.model === "on" ? S.modelOn : S.modelOff)}>
                <strong>{view.cost.requests}</strong> {t(S.requests)} · <strong>{dollars(view.cost.nano)}</strong> {t(S.confirmed)}
              </span>
            </div>
          )}
          <button className="lang" onClick={() => setLang(lang === "en" ? "zh" : "en")} aria-label={t(S.languageLabel)}>
            {t(S.language)}
          </button>
        </div>
      </header>

      {error && (
        <div className="banner error" role="alert">
          <span>{t(error)}</span>
          <button onClick={() => setError(null)}>{t(S.dismiss)}</button>
        </div>
      )}
      {notice && (
        <div className="banner notice" role="status">
          <span>{t(notice)}</span>
          <button onClick={() => setNotice(null)}>{t(S.dismiss)}</button>
        </div>
      )}

      {view ? (
        <Game
          view={view}
          lang={lang}
          busy={busy}
          shown={shown}
          onTopic={(topic) => run(() => api.askTopic(view, topic, lang), view)}
          onOwn={(person, question) => run(() => api.askOwn(view, person, question), view)}
          onInspect={(inspection) => run(() => api.inspect(view, inspection), view)}
          onAccuse={(person, evidence) => run(() => api.accuse(view, person, evidence), view)}
          onLeave={leave}
        />
      ) : (
        <Library cases={cases} lang={lang} busy={busy} onOpen={(id) => run(() => api.start(id), null)} />
      )}
    </div>
  );
}

function Library({ cases, lang, busy, onOpen }: { cases: CasesReply | null; lang: Lang; busy: boolean; onOpen: (id: string) => void }) {
  const t = (text: Text) => pick(lang, text);
  return (
    <main className="library">
      <h1>{t(S.library)}</h1>
      <p className="hint">{t(S.libraryHint)}</p>
      {cases && <p className={`model ${cases.model}`}>{t(cases.model === "on" ? S.modelOn : S.modelOff)}</p>}
      {!cases && <p className="hint">{t(S.loading)}</p>}
      {cases && cases.cases.length === 0 && <p className="hint">{t(S.noCases)}</p>}
      <div className="cards">
        {cases?.cases.map((c) => (
          <article className="card" key={c.id}>
            <h2>{t(c.title)}</h2>
            <p>{t(c.setting)}</p>
            <p className="facts">
              {c.suspects} {t(S.people)} · {c.rooms} {t(S.rooms)} · {c.actions} {t(S.actionsCap)}
            </p>
            <button className="primary" disabled={busy} onClick={() => onOpen(c.id)}>
              {t(S.open)}
            </button>
          </article>
        ))}
      </div>
    </main>
  );
}

interface GameProps {
  view: View;
  lang: Lang;
  busy: boolean;
  shown: Shown | null;
  onTopic: (topic: string) => void;
  onOwn: (person: string, question: string) => void;
  onInspect: (inspection: string) => void;
  onAccuse: (person: string, evidence: string[]) => void;
  onLeave: () => void;
}

function Game({ view, lang, busy, shown, onTopic, onOwn, onInspect, onAccuse, onLeave }: GameProps) {
  const t = (text: Text) => pick(lang, text);
  const [selected, setSelected] = useState<string | null>(null);
  const [accusing, setAccusing] = useState(false);
  const [question, setQuestion] = useState("");
  const names = useMemo(() => new Map(view.people.map((p) => [p.handle, p])), [view.people]);
  const nameOf = (handle: string) => {
    const person = names.get(handle);
    return person ? t(person.name) : handle;
  };
  const person = selected ? names.get(selected) : undefined;
  const locked = busy || view.over;

  if (view.over && view.verdict && view.reveal) return <Verdict view={view} lang={lang} nameOf={nameOf} onLeave={onLeave} />;

  const topics = view.topics.filter((x) => x.person === selected);
  const lines = view.transcript.filter((x) => x.person === selected);
  const sourceText = (source: string): Text => (source === "model" || source === "model-retry" ? S.sourceModel : source === "rendered" ? S.sourceRendered : S.sourceDeflection);

  return (
    <main className="game">
      <section className="briefing">
        <h1>{t(view.title)}</h1>
        <p>{t(view.setting)}</p>
        <p className="victim">{victimLine(lang, view.victim)}</p>
        <p>{t(view.victim.cause)}</p>
        <p className={`model ${view.model}`}>{t(view.model === "on" ? S.modelOn : S.modelOff)}</p>
        <details className="rules" open={view.actions.used === 0}>
          <summary>{t(S.rules)}</summary>
          <ol>
            {view.rules.map((rule, i) => (
              <li key={i}>{t(rule)}</li>
            ))}
          </ol>
        </details>
      </section>

      <div className="columns">
        <section className="panel people" aria-label={t(S.peopleTitle)}>
          <h2>{t(S.peopleTitle)}</h2>
          <ul>
            {view.people.map((p) => {
              const heard = view.topics.filter((x) => x.person === p.handle && x.heard).length;
              return (
                <li key={p.handle}>
                  <button className={p.handle === selected ? "person on" : "person"} onClick={() => setSelected(p.handle)} aria-pressed={p.handle === selected}>
                    <span className="person-name">{t(p.name)}</span>
                    <span className="person-role">{t(p.role)}</span>
                    {heard > 0 && <span className="badge">{heard}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="panel talk">
          {!person && <p className="hint">{t(S.pickPerson)}</p>}
          {person && (
            <>
              <h2>
                {t(person.name)} <span className="role">{t(person.role)}</span>
              </h2>
              <h3>{t(S.topics)}</h3>
              <div className="topics">
                {topics.map((x) => (
                  <button key={x.handle} className={x.heard ? "topic heard" : "topic"} disabled={locked} onClick={() => onTopic(x.handle)}>
                    {t(x.label)}
                    {x.heard && <span className="tick"> ✓ {t(S.heard)}</span>}
                  </button>
                ))}
              </div>
              <h3>{t(S.ownWords)}</h3>
              {view.model === "on" ? (
                <form
                  className="own"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const words = question.trim();
                    if (!words || locked) return;
                    onOwn(person.handle, words);
                    setQuestion("");
                  }}
                >
                  <input value={question} maxLength={300} onChange={(e) => setQuestion(e.target.value)} placeholder={t(S.ownWordsPlaceholder)} disabled={locked} />
                  <button className="primary" disabled={locked || question.trim().length === 0}>
                    {t(S.send)}
                  </button>
                </form>
              ) : (
                <p className="hint">{t(S.ownWordsOff)}</p>
              )}
              <div className="chat" aria-live="polite">
                {lines.length === 0 && <p className="hint">{t(S.nothingAsked)}</p>}
                {lines.map((line) => (
                  <div className="exchange" key={line.n}>
                    <p className="q">{line.question}</p>
                    <p className="a" lang={line.language === "zh" ? "zh-Hans" : "en"}>
                      {line.line}
                    </p>
                    <p className="tags">
                      <span className={`tag ${line.source}`}>{t(sourceText(line.source))}</span>
                      {line.noted > 0 && (
                        <span className="tag noted">
                          +{line.noted} {t(S.noted)}
                        </span>
                      )}
                    </p>
                  </div>
                ))}
                {shown && shown.person === selected && (
                  <div className="exchange again">
                    <p className="a" lang={shown.language === "zh" ? "zh-Hans" : "en"}>
                      {shown.line}
                    </p>
                    <p className="tags">
                      <span className="tag">{t(shown.language === "zh" ? S.againZh : S.againEn)}</span>
                    </p>
                  </div>
                )}
                {busy && <p className="hint">{t(S.working)}</p>}
              </div>
            </>
          )}
        </section>

        <section className="panel notebook" aria-label={t(S.notebook)}>
          <h2>{t(S.notebook)}</h2>
          <h3>{t(S.evidence)}</h3>
          <ul className="evidence">
            {view.evidence.map((e) => (
              <li key={e.handle} className={e.note ? "note" : ""}>
                <span className="handle">{e.handle}</span>
                <span>
                  {t(e.text)} {e.note && <em className="note-mark">{t(view.noteMark)}</em>}
                </span>
              </li>
            ))}
          </ul>
          <h3>{t(S.inspect)}</h3>
          <div className="inspections">
            {view.inspections.filter((x) => !x.done).length === 0 && <p className="hint">{t(S.nothingToInspect)}</p>}
            {view.inspections.map((x) =>
              x.done ? (
                <p key={x.handle} className="done">
                  ✓ {t(x.label)} <span className="tick">{t(S.inspected)}</span>
                </p>
              ) : (
                <button key={x.handle} className="inspection" disabled={locked || view.actions.left === 0} onClick={() => onInspect(x.handle)}>
                  {t(x.label)}
                </button>
              ),
            )}
          </div>
          <h3>{t(S.statements)}</h3>
          {view.statements.length === 0 && <p className="hint">{t(S.noStatements)}</p>}
          <ul className="statements">
            {view.statements.map((st) => (
              <li key={st.key} className={st.contradictedBy.length > 0 ? "against" : ""}>
                <strong>{nameOf(st.person)}</strong>: {t(st.text)}
                {st.contradictedBy.length > 0 && (
                  <span className="contra">
                    {" "}
                    ⚠ {t(S.contradictedBy)} {st.contradictedBy.join(", ")}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {view.actions.left === 0 && <p className="hint">{t(S.noActions)}</p>}
          <button className="primary accuse" disabled={busy} onClick={() => setAccusing(true)}>
            {t(S.accuse)}
          </button>
        </section>
      </div>

      {accusing && <Accuse view={view} lang={lang} busy={busy} onCancel={() => setAccusing(false)} onAccuse={onAccuse} />}
    </main>
  );
}

function Accuse({ view, lang, busy, onCancel, onAccuse }: { view: View; lang: Lang; busy: boolean; onCancel: () => void; onAccuse: (person: string, evidence: string[]) => void }) {
  const t = (text: Text) => pick(lang, text);
  // Nobody is chosen to begin with: an accusation ends the case, so it is never one click away from the person being questioned.
  const [who, setWho] = useState("");
  const [cited, setCited] = useState<Set<string>>(() => new Set(view.evidence.map((e) => e.handle)));
  const toggle = (handle: string) => {
    const next = new Set(cited);
    if (next.has(handle)) next.delete(handle);
    else next.add(handle);
    setCited(next);
  };
  // The browser's own modal dialog: it takes the focus, keeps Tab inside, makes the page
  // behind it inert, closes on Escape, and gives the focus back when it closes.
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    // Whatever opened the dialog gets the focus back when it goes: the dialog is removed
    // from the page as it closes, so the browser cannot do that part itself.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (element && !element.open) element.showModal();
    return () => {
      element?.close();
      opener?.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="dialog"
      aria-labelledby="accuse-title"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <div>
        <h2 id="accuse-title">{t(S.accuseTitle)}</h2>
        <p className="warn">{t(S.accuseWarn)}</p>
        <label>
          {t(S.whom)}
          <select value={who} onChange={(e) => setWho(e.target.value)} autoFocus>
            <option value="">{t(S.choose)}</option>
            {view.people.map((p) => (
              <option key={p.handle} value={p.handle}>
                {t(p.name)} — {t(p.role)}
              </option>
            ))}
          </select>
        </label>
        <div className="cite-head">
          <span>{t(S.cite)}</span>
          <span>
            <button type="button" className="link" onClick={() => setCited(new Set(view.evidence.map((e) => e.handle)))}>
              {t(S.citeAll)}
            </button>
            <button type="button" className="link" onClick={() => setCited(new Set())}>
              {t(S.citeNone)}
            </button>
          </span>
        </div>
        <ul className="cite">
          {view.evidence.map((e) => (
            <li key={e.handle}>
              <label>
                <input type="checkbox" checked={cited.has(e.handle)} onChange={() => toggle(e.handle)} />
                <span className="handle">{e.handle}</span>
                <span>
                  {t(e.text)} {e.note && <em className="note-mark">{t(view.noteMark)}</em>}
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div className="dialog-actions">
          <button onClick={onCancel}>{t(S.cancel)}</button>
          <button className="primary danger" disabled={busy || who === ""} onClick={() => onAccuse(who, view.evidence.filter((e) => cited.has(e.handle)).map((e) => e.handle))}>
            {t(S.confirmAccuse)}
          </button>
        </div>
      </div>
    </dialog>
  );
}

function Verdict({ view, lang, nameOf, onLeave }: { view: View; lang: Lang; nameOf: (handle: string) => string; onLeave: () => void }) {
  const t = (text: Text) => pick(lang, text);
  const v = view.verdict!;
  const truth = view.reveal!;
  const headline = v.outcome === "solved" ? S.verdictSolved : v.outcome === "right-but-unproven" ? S.verdictUnproven : S.verdictWrong;
  const missing: Record<string, Text> = { opportunity: S.opportunity, means: S.means, motive: S.motive };
  // Each language has its own full stop, comma and spacing.
  const stop = lang === "zh" ? "。" : ".";
  const comma = lang === "zh" ? "、" : ", ";
  const gap = lang === "zh" ? "" : " ";
  // The verdict replaces the game on the same page: start reading it from the top.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);
  return (
    <main className="verdict">
      <section className={`outcome ${v.outcome}`}>
        <h1>{t(headline)}</h1>
        <p>
          {t(S.youAccused)}
          {gap}
          <strong>{nameOf(v.accused)}</strong>
          {stop}
        </p>
        {v.accusedRuledOut && <p>{t(S.ruledOutByOwn)}</p>}
        {v.missing.length > 0 && (
          <p>
            {t(S.notProven)}
            {lang === "zh" ? "：" : ": "}
            {v.missing.map((m) => t(missing[m] ?? S.motive)).join(comma)}
            {stop}
          </p>
        )}
        {v.open.length > 0 && (
          <p>
            {t(S.notRuledOut)}
            {lang === "zh" ? "：" : ": "}
            {v.open.map(nameOf).join(comma)}
            {stop}
          </p>
        )}
      </section>
      <section className="panel">
        <h2>{t(S.truth)}</h2>
        <p className="culprit">
          {t(S.itWas)}
          {gap}
          <strong>{nameOf(truth.culprit)}</strong>
          {stop}
        </p>
        <p>{t(truth.motive)}</p>
        {truth.lies.length > 0 && (
          <>
            <h3>{t(S.lies)}</h3>
            <ul className="lies">
              {truth.lies.map((lie, i) => (
                <li key={i} className={lie.caught ? "caught" : ""}>
                  <strong>{nameOf(lie.person)}</strong>: “{t(lie.text)}” — {t(lie.caught ? S.lieCaught : lie.heard ? S.lieHeard : S.lieMissed)}
                </li>
              ))}
            </ul>
          </>
        )}
        <h3>{t(S.whereEveryoneWas)}</h3>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>{t(S.person)}</th>
                {view.slots.map((slot) => (
                  <th key={slot}>{slot}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {truth.timeline.map((row) => (
                <tr key={row.person} className={row.person === truth.culprit ? "culprit-row" : ""}>
                  <td>{nameOf(row.person)}</td>
                  {row.at.map((x) => (
                    <td key={x.slot}>{t(x.room)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button className="primary" onClick={onLeave}>
          {t(S.playAnother)}
        </button>
      </section>
    </main>
  );
}
