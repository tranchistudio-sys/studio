const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function getToken() {
  return localStorage.getItem("amazingStudioToken_v2");
}

function authHeaders(): HeadersInit {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

export async function registerPushNotifications(): Promise<boolean> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    console.log("[push] Not supported");
    return false;
  }
  if (!import.meta.env.PROD) {
    console.log("[push] Skipped in dev to avoid forced reloads");
    return false;
  }

  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      console.log("[push] Permission denied");
      return false;
    }

    const registration = await navigator.serviceWorker.register(`${BASE}/sw.js`, { scope: `${BASE}/` });
    await navigator.serviceWorker.ready;

    const vapidRes = await fetch(`${BASE}/api/push/vapid-key`);
    if (!vapidRes.ok) return false;
    const { publicKey } = await vapidRes.json();

    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });
    }

    const subJson = subscription.toJSON();
    const res = await fetch(`${BASE}/api/push/subscribe`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        endpoint: subJson.endpoint,
        p256dh: subJson.keys?.p256dh,
        auth: subJson.keys?.auth,
      }),
    });

    if (res.ok) {
      localStorage.setItem("pushRegistered", "1");
      console.log("[push] Registered successfully");
      return true;
    }
    return false;
  } catch (err) {
    console.error("[push] Registration error:", err);
    return false;
  }
}

export async function unregisterPush(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker.getRegistration(`${BASE}/`);
    if (registration) {
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const endpoint = subscription.endpoint;
        await subscription.unsubscribe();
        await fetch(`${BASE}/api/push/unsubscribe`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ endpoint }),
        });
      }
    }
    localStorage.removeItem("pushRegistered");
  } catch (err) {
    console.error("[push] Unregister error:", err);
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
