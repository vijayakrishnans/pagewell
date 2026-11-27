"use client";

import * as React from "react";
import { useSession } from "@/lib/session";
import { appConfig } from "@/lib/app-config";
import { editorOrigin, editorUrl, handoffReply } from "@/lib/drive";

const HANDOFF_WINDOW_MS = 60_000;

/**
 * Open a document in Pagewell's editor, in a new tab, and hand that tab the
 * session when it asks (see lib/drive.ts). Returns null when signed out.
 */
export function useOpenInEditor(orgId: string): ((docId: string) => void) | null {
  const { token, target } = useSession();
  return React.useMemo(() => {
    if (!token) return null;
    return (docId: string) => {
      const origin = editorOrigin(appConfig(), target.name);
      const tab = window.open(editorUrl(origin, orgId, docId), "_blank");
      if (!tab) return;
      const onMessage = (event: MessageEvent) => {
        const reply = handoffReply(event, { origin, window: tab, token, apiBase: target.url, orgId });
        if (!reply) return;
        tab.postMessage(reply, origin);
        stop();
      };
      const timer = window.setTimeout(() => stop(), HANDOFF_WINDOW_MS);
      const stop = () => {
        window.removeEventListener("message", onMessage);
        window.clearTimeout(timer);
      };
      window.addEventListener("message", onMessage);
    };
  }, [orgId, token, target]);
}
