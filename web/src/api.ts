// Types only. The page never imports the server's code: the case library must not be bundled into it.
import type { ApiError, CasesReply, ViewReply } from "../../src/web/api";
import type { View } from "../../src/web/view";
import { S, type Text } from "./strings";

export type { CasesReply, View, ViewReply };

/** A refusal from the server, or a failure to reach it. Its text is ready to show in either language. */
export class GameError extends Error {
  constructor(
    readonly code: string,
    readonly text: Text,
  ) {
    super(code);
  }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    // The visitor's secret travels in a cookie this script cannot read; the browser sends it for us.
    response = await fetch(path, { method, credentials: "same-origin", ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  } catch {
    throw new GameError("network", S.networkError);
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new GameError("network", S.networkError);
  }
  if (!response.ok) {
    const error = (data as Partial<ApiError>).error;
    throw new GameError(error?.code ?? "network", error?.text ?? S.networkError);
  }
  return data as T;
}

export const api = {
  cases: () => call<CasesReply>("GET", "/api/cases"),
  start: (caseId: string) => call<ViewReply>("POST", "/api/sessions", { caseId }),
  view: (session: string) => call<ViewReply>("GET", `/api/sessions/${session}`),
  askTopic: (view: View, topic: string, language: "en" | "zh") => call<ViewReply>("POST", `/api/sessions/${view.session}/ask`, { revision: view.revision, topic, language }),
  askOwn: (view: View, person: string, question: string) => call<ViewReply>("POST", `/api/sessions/${view.session}/ask`, { revision: view.revision, person, question }),
  inspect: (view: View, inspection: string) => call<ViewReply>("POST", `/api/sessions/${view.session}/inspect`, { revision: view.revision, inspection }),
  accuse: (view: View, person: string, evidence: string[]) => call<ViewReply>("POST", `/api/sessions/${view.session}/accuse`, { revision: view.revision, person, evidence }),
};
