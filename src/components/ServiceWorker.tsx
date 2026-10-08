"use client";

import { useEffect } from "react";

/**
 * Registers `/sw.js` once the page has loaded. It only handles notifications
 * (no caching), so registering it everywhere costs nothing and keeps reminders
 * working on a device after it subscribed once.
 */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration> | null {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  return navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
}

export function ServiceWorker() {
  useEffect(() => {
    registerServiceWorker()?.catch(() => {
      // Private windows and some embedded browsers refuse; nothing depends on it.
    });
  }, []);
  return null;
}
