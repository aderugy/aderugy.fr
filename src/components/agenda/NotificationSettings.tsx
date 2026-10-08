"use client";

import { useEffect, useState, useSyncExternalStore, useTransition } from "react";
import { registerServiceWorker } from "@/components/ServiceWorker";
import {
  removeSubscription,
  saveSubscription,
  sendTestNotification,
  setReminderPrefs,
} from "@/server/actions/notifications";
import { relativeTime } from "./GoogleConnection";

export type PushDevice = {
  id: string;
  endpoint: string;
  label: string | null;
  created_at: string;
  last_success_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
};

export type ReminderPrefs = { blockReminders: boolean; leadMinutes: number };

const LEADS = [0, 5, 10, 15, 30, 60];

/**
 * What this browser can do, as a string so it can be a store snapshot:
 * "checking" on the server, then "unsupported", "ios-not-installed" (iPhone or
 * iPad in Safari: push exists only once added to the Home Screen), or
 * "ready:<permission>".
 */
type Support = "checking" | "unsupported" | "ios-not-installed" | `ready:${NotificationPermission}`;

function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function sameBytes(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (!a) return true; // Not exposed by this browser: assume it matches.
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

/** "Chrome on Windows" — enough to tell a phone from a laptop in the list. */
function deviceLabel(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "unknown OS";
  const installed = window.matchMedia("(display-mode: standalone)").matches ? " (app)" : "";
  return `${browser} on ${os}${installed}`;
}

function detectSupport(): Support {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (ios && !standalone) return "ios-not-installed";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return "unsupported";
  }
  return `ready:${Notification.permission}`;
}

// Permission has no change event worth relying on; every render re-reads it,
// and the buttons that change it always cause one.
const noSubscribe = () => () => {};

export function NotificationSettings({
  devices,
  prefs,
}: {
  devices: PushDevice[];
  prefs: ReminderPrefs;
}) {
  const support = useSyncExternalStore(noSubscribe, detectSupport, () => "checking" as Support);
  const ready = support.startsWith("ready:");
  const permission = ready ? support.slice("ready:".length) : null;

  const [thisEndpoint, setThisEndpoint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

  // Which subscription, if any, this browser already holds.
  useEffect(() => {
    if (!ready) return;
    registerServiceWorker()
      ?.then((registration) => registration.pushManager.getSubscription())
      .then((sub) => setThisEndpoint(sub?.endpoint ?? null))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [ready]);

  const thisDeviceOn = thisEndpoint !== null && devices.some((d) => d.endpoint === thisEndpoint);

  function run(work: () => Promise<void>) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        await work();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  function enable() {
    run(async () => {
      if (!vapidKey) throw new Error("NEXT_PUBLIC_VAPID_PUBLIC_KEY is not set on this deployment.");
      const granted = await Notification.requestPermission();
      if (granted !== "granted") {
        throw new Error(
          granted === "denied"
            ? "Notifications are blocked for this site. Allow them in the browser's site settings, then try again."
            : "Permission was not granted.",
        );
      }

      const registration = await registerServiceWorker();
      if (!registration) throw new Error("Service workers are unavailable here.");
      await navigator.serviceWorker.ready;

      const serverKey = base64UrlToBytes(vapidKey);
      let sub = await registration.pushManager.getSubscription();
      // A subscription made under another key (rotated VAPID keys) is useless.
      if (sub && !sameBytes(sub.options.applicationServerKey, serverKey)) {
        await sub.unsubscribe();
        sub = null;
      }
      sub ??= await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: serverKey,
      });

      const json = sub.toJSON();
      const result = await saveSubscription({
        endpoint: sub.endpoint,
        p256dh: json.keys?.p256dh ?? "",
        auth: json.keys?.auth ?? "",
        label: deviceLabel(),
      });
      if (!result.ok) throw new Error(result.error);
      setThisEndpoint(sub.endpoint);
    });
  }

  function disableHere() {
    run(async () => {
      const registration = await registerServiceWorker();
      const sub = await registration?.pushManager.getSubscription();
      if (sub) {
        const result = await removeSubscription({ endpoint: sub.endpoint });
        if (!result.ok) throw new Error(result.error);
        await sub.unsubscribe();
      }
      setThisEndpoint(null);
    });
  }

  function removeDevice(device: PushDevice) {
    run(async () => {
      const result = await removeSubscription({ id: device.id });
      if (!result.ok) throw new Error(result.error);
    });
  }

  function savePrefs(next: ReminderPrefs) {
    run(async () => {
      const result = await setReminderPrefs(next);
      if (!result.ok) throw new Error(result.error);
    });
  }

  function test() {
    run(async () => {
      const result = await sendTestNotification();
      if (!result.ok) throw new Error(result.error);
      if ("delivered" in result) {
        setNotice(`Sent to ${result.delivered} of ${result.devices} device${result.devices > 1 ? "s" : ""}.`);
      }
    });
  }

  return (
    <section className="rounded-lg border border-line bg-surface p-4 text-sm">
      <h2 className="font-medium">Notifications</h2>
      <p className="mt-0.5 text-xs text-muted">
        A reminder on your devices before each planned block starts. Each device opts in on its
        own: turn it on here from your phone and from your computer.
      </p>

      {error && (
        <p className="mt-3 rounded border border-red-500/40 bg-red-500/5 p-2 text-xs text-red-500">
          {error}
        </p>
      )}
      {notice && (
        <p className="mt-3 rounded border border-line bg-background p-2 text-xs">{notice}</p>
      )}

      {/* ------------------------------------------------- this device */}
      <div className="mt-3 flex flex-wrap items-center gap-3 rounded border border-line px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium">This device</p>
          <p className="text-xs text-muted">
            {support === "checking" && "Checking…"}
            {support === "unsupported" && "This browser cannot receive push notifications."}
            {support === "ios-not-installed" &&
              "On iPhone and iPad, notifications need the app: Share → Add to Home Screen, then open it from there and come back to this page."}
            {ready &&
              (permission === "denied"
                ? "Blocked in the browser's site settings."
                : thisDeviceOn
                  ? "On."
                  : "Off.")}
          </p>
        </div>
        {ready &&
          (thisDeviceOn ? (
            <button
              type="button"
              onClick={disableHere}
              disabled={pending}
              className="rounded border border-line px-2 py-1 text-xs hover:border-foreground disabled:opacity-50"
            >
              Turn off here
            </button>
          ) : (
            <button
              type="button"
              onClick={enable}
              disabled={pending || permission === "denied"}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              Turn on here
            </button>
          ))}
      </div>

      {/* ------------------------------------------------- preferences */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={prefs.blockReminders}
            disabled={pending}
            onChange={(e) => savePrefs({ ...prefs, blockReminders: e.target.checked })}
          />
          Remind me before blocks
        </label>
        <label className="flex items-center gap-2 text-xs text-muted">
          <select
            value={prefs.leadMinutes}
            disabled={pending || !prefs.blockReminders}
            onChange={(e) => savePrefs({ ...prefs, leadMinutes: Number(e.target.value) })}
            className="rounded border border-line bg-background px-1.5 py-1 text-sm text-foreground"
          >
            {LEADS.map((m) => (
              <option key={m} value={m}>
                {m === 0 ? "at the start" : `${m} min before`}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={test}
          disabled={pending || devices.length === 0}
          className="ml-auto rounded border border-line px-2 py-1 text-xs hover:border-foreground disabled:opacity-50"
        >
          Send a test
        </button>
      </div>

      {/* --------------------------------------------------- all devices */}
      {devices.length > 0 && (
        <ul className="mt-3 space-y-2">
          {devices.map((d) => (
            <li key={d.id} className="flex items-center gap-3 rounded border border-line px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate">
                  {d.label || "Unnamed device"}
                  {d.endpoint === thisEndpoint && <span className="text-muted"> · this one</span>}
                </p>
                <p className="text-xs text-muted">
                  Added {relativeTime(d.created_at)}
                  {d.last_success_at && ` · last delivered ${relativeTime(d.last_success_at)}`}
                </p>
                {d.last_error && (
                  <p className="truncate text-xs text-red-500" title={d.last_error}>
                    {d.last_error}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => removeDevice(d)}
                disabled={pending}
                className="rounded border border-line px-2 py-1 text-xs text-red-500 hover:border-red-500 disabled:opacity-50"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
